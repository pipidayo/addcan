'use client'
import styles from './styles.module.css'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState, useRef, useCallback } from 'react'
// 修正された PeerManager とその関数をインポート
import PeerManager, {
  callPeer,
  disconnectAll,
  sendUserName,
  sendMuteStatus,
} from '../PeerManager'
import io, { Socket } from 'socket.io-client' // socket.io-client をインポート

// WebSocket サーバーの URL (環境変数などから取得するのが望ましい)
const WEBSOCKET_SERVER_URL = 'http://localhost:3001' // サーバーを起動している URL に合わせる

export default function CallScreen() {
  const { room: roomCodeParam } = useParams()
  const roomCode = Array.isArray(roomCodeParam)
    ? roomCodeParam[0]
    : roomCodeParam
  const router = useRouter()
  const socketRef = useRef<Socket | null>(null) // WebSocket のインスタンス

  const [myPeerId, setMyPeerId] = useState('')
  const [myName, setMyName] = useState('')
  const [userNames, setUserNames] = useState<{ [id: string]: string }>({}) // ピアIDと名前のマッピング (参加者管理)
  const [peerMuteMap, setPeerMuteMap] = useState<{ [id: string]: boolean }>({}) // ピアIDとミュート状態
  const audioRefs = useRef<{ [id: string]: HTMLAudioElement }>({}) // IDでオーディオ要素を管理
  // connectedIds は不要になる (接続管理は PeerManager と WebSocket で行う)
  // const connectedIds = useRef<string[]>([]);
  const [isMuted, setIsMuted] = useState(false)
  const localStreamRef = useRef<MediaStream | null>(null)
  const myPeerIdRef = useRef<string>('') // クリーンアップ用

  // 自分のミュート状態を切り替える関数
  const toggleMic = useCallback(() => {
    if (!localStreamRef.current) return
    const audioTrack = localStreamRef.current.getAudioTracks()[0]
    if (audioTrack) {
      const newEnabledState = !audioTrack.enabled
      audioTrack.enabled = newEnabledState
      const newMuteState = !newEnabledState
      setIsMuted(newMuteState)
      // PeerManager 経由でミュート状態を送信
      sendMuteStatus(newMuteState)
      console.log('Mute status sent via PeerManager:', newMuteState)
    }
  }, []) // 依存配列は空

  // 他のピアの名前を更新する関数
  const updateUserName = useCallback((peerId: string, name: string) => {
    console.log(`CallScreen: Updating username for ${peerId}: ${name}`)
    setUserNames((prev) => ({ ...prev, [peerId]: name }))
  }, [])

  // 他のピアのミュート状態を更新する関数
  const updateMuteStatus = useCallback((peerId: string, isMuted: boolean) => {
    console.log(`CallScreen: Updating mute status for ${peerId}: ${isMuted}`)
    setPeerMuteMap((prev) => ({ ...prev, [peerId]: isMuted }))
  }, [])

  // ピアが切断されたときに状態から削除する関数
  const removePeer = useCallback((peerId: string) => {
    console.log(`CallScreen: Removing peer: ${peerId}`)
    setPeerMuteMap((prev) => {
      const newMap = { ...prev }
      delete newMap[peerId]
      return newMap
    })
    setUserNames((prev) => {
      const newMap = { ...prev }
      delete newMap[peerId]
      return newMap
    })
    // オーディオ要素を停止・削除
    if (audioRefs.current[peerId]) {
      const audio = audioRefs.current[peerId]
      audio.pause()
      audio.srcObject = null
      delete audioRefs.current[peerId]
      console.log(`CallScreen: Removed audio for peer: ${peerId}`)
    }
  }, [])

  // コンポーネントのマウント時と roomCode 変更時に実行
  useEffect(() => {
    if (!roomCode) {
      alert('ルームコードがありません')
      router.push('/')
      return
    }

    const nameFromStorage = localStorage.getItem('my_name')
    if (!nameFromStorage) {
      alert('名前が設定されていません')
      router.push('/')
      return
    }
    setMyName(nameFromStorage)

    let isMounted = true // マウント状態を追跡
    let currentPeerId = '' // Peer ID をローカル変数で保持

    // --- WebSocket 接続 ---
    console.log('CallScreen: Connecting to WebSocket server...')
    const socket = io(WEBSOCKET_SERVER_URL)
    socketRef.current = socket

    // WebSocket イベントリスナー設定
    const setupWebSocketListeners = (peerIdForSocket: string) => {
      socket.on('connect', () => {
        console.log('CallScreen: WebSocket connected:', socket.id)
        // サーバーにルーム参加を通知 (Peer ID 確定後)
        console.log(
          `CallScreen: Emitting join-room with peerId: ${peerIdForSocket}`
        )
        socket.emit('join-room', {
          roomCode,
          peerId: peerIdForSocket,
          name: nameFromStorage,
        })
      })

      socket.on('disconnect', (reason) => {
        console.log('CallScreen: WebSocket disconnected:', reason)
        // 必要に応じて再接続処理など
      })

      socket.on('connect_error', (error) => {
        console.error('CallScreen: WebSocket connection error:', error)
        if (isMounted) {
          alert('サーバーとの接続に失敗しました。')
          // router.push('/'); // エラー時にトップに戻す場合
        }
      })

      // 他のユーザーが参加したときのイベント
      socket.on(
        'user-joined',
        ({ peerId, name }: { peerId: string; name: string }) => {
          if (!isMounted || peerId === currentPeerId) return // 自分自身は無視
          console.log(`CallScreen: User joined: ${name} (${peerId})`)
          updateUserName(peerId, name) // 参加者リストに追加

          // 新しい参加者に接続 (PeerManager 経由で発信)
          console.log(`CallScreen: Attempting to call new peer: ${peerId}`)
          callPeer(peerId).catch((error) => {
            console.error(
              `CallScreen: Failed to call new peer ${peerId}:`,
              error
            )
          })
        }
      )

      // 他のユーザーが退出したときのイベント
      socket.on('user-left', ({ peerId }: { peerId: string }) => {
        if (!isMounted) return
        console.log(`CallScreen: User left: ${peerId}`)
        // PeerManager 側で handleDisconnect が呼ばれるはずなので、
        // removePeer は onPeerDisconnect コールバックで呼び出す
        // removePeer(peerId); // ここでは呼ばない
      })

      // 他のユーザーの名前更新イベント (PeerManager 経由で処理されるはず)
      // socket.on('user-name-update', ({ peerId, name }: { peerId: string; name: string }) => {
      //   if (!isMounted) return;
      //   updateUserName(peerId, name);
      // });

      // 他のユーザーのミュート状態更新イベント (PeerManager 経由で処理されるはず)
      // socket.on('mute-status-update', ({ peerId, isMuted }: { peerId: string; isMuted: boolean }) => {
      //   if (!isMounted) return;
      //   updateMuteStatus(peerId, isMuted);
      // });

      // 既存の参加者リストを取得するイベント
      socket.on(
        'existing-participants',
        (participantsData: { [id: string]: string }) => {
          // サーバーからの型に合わせる
          if (!isMounted) return
          console.log(
            'CallScreen: Received existing participants:',
            participantsData
          )
          const initialUserNames: { [id: string]: string } = {}
          // const initialMuteMap: { [id: string]: boolean } = {}; // ミュート状態もサーバーが送るなら追加
          Object.entries(participantsData).forEach(([id, name]) => {
            if (id !== currentPeerId) {
              // 自分自身は除外
              initialUserNames[id] = name
              // initialMuteMap[id] = data.isMuted; // ミュート状態も受け取る場合

              // 既存の参加者にも接続 (PeerManager 経由で発信)
              console.log(`CallScreen: Attempting to call existing peer: ${id}`)
              callPeer(id).catch((error) => {
                console.error(
                  `CallScreen: Failed to call existing peer ${id}:`,
                  error
                )
              })
            }
          })
          // 自分の名前もマージして state を更新
          setUserNames((prev) => ({
            ...prev,
            ...initialUserNames,
            [currentPeerId]: nameFromStorage,
          }))
          // setPeerMuteMap(prev => ({ ...prev, ...initialMuteMap }));
        }
      )
    }

    // PeerJS の初期化
    const initialize = async () => {
      try {
        // PeerManager の initPeer を呼び出し
        const peerId = await initPeer(
          {
            // initPeer を直接呼び出す
            roomCode: roomCode,
            // --- PeerManager に渡すコールバック関数 ---
            onReceiveStream: (stream, peerId) => {
              if (!isMounted) return
              console.log(`CallScreen: Received stream from ${peerId}`)
              if (!audioRefs.current[peerId]) {
                const audio = new Audio()
                audio.srcObject = stream
                audio.dataset.peerId = peerId
                // 音声が再生されない場合があるため、ユーザー操作後に再生するなどの工夫が必要な場合あり
                audio
                  .play()
                  .catch((e) => console.error('Audio play failed:', e))
                audioRefs.current[peerId] = audio
              }
            },
            onPeerOpen: (id) => {
              if (!isMounted) return
              console.log('CallScreen: Peer opened with ID:', id)
              currentPeerId = id // ローカル変数に保持
              setMyPeerId(id)
              myPeerIdRef.current = id
              setUserNames((prev) => ({ ...prev, [id]: nameFromStorage })) // 自分の名前をマップに追加

              // WebSocket リスナーを設定 (Peer ID 確定後)
              setupWebSocketListeners(id)
            },
            onLocalStream: (stream) => {
              if (!isMounted) return
              console.log('CallScreen: Local stream obtained.')
              localStreamRef.current = stream
              const audioTrack = stream.getAudioTracks()[0]
              if (audioTrack) {
                audioTrack.enabled = !isMuted // 初期ミュート状態を適用
              }
            },
            onReceiveUserName: (peerId, name) => {
              if (!isMounted) return
              updateUserName(peerId, name)
            },
            onReceiveMuteStatus: (peerId, isMuted) => {
              if (!isMounted) return
              updateMuteStatus(peerId, isMuted)
            },
            onPeerDisconnect: (peerId) => {
              if (!isMounted) return
              removePeer(peerId)
            },
            // --- ここまでコールバック ---
          },
          nameFromStorage
        ) // 自分の名前を渡す
      } catch (error) {
        console.error('CallScreen: PeerJS initialization failed:', error)
        if (isMounted) {
          alert(
            '通話機能の初期化に失敗しました。ページを再読み込みしてください。'
          )
        }
      }
    }

    initialize()

    // クリーンアップ関数
    return () => {
      isMounted = false
      console.log('CallScreen: Cleaning up...')
      // WebSocket 接続を切断
      const currentPeerIdForCleanup = myPeerIdRef.current // ref から取得
      socketRef.current?.emit('leave-room', {
        roomCode,
        peerId: currentPeerIdForCleanup,
      })
      socketRef.current?.disconnect()
      socketRef.current = null
      console.log('CallScreen: WebSocket disconnected on cleanup.')

      // PeerManager の切断処理
      disconnectAll() // PeerManager の disconnectAll を呼び出す

      // オーディオ要素を停止・削除
      Object.values(audioRefs.current).forEach((audio) => {
        audio.pause()
        audio.srcObject = null
      })
      audioRefs.current = {}
      // ローカルストリームは PeerManager 内で停止されるはず
      // localStreamRef.current?.getTracks().forEach(track => track.stop());
      localStreamRef.current = null
      myPeerIdRef.current = '' // ref をリセット
    }
    // }, [roomCode, router, isMuted, updateUserName, updateMuteStatus, removePeer]); // 依存配列を見直し
  }, [roomCode, router]) // router 以外の state 更新関数は useCallback でメモ化されていれば不要

  // 退出処理
  const leaveRoom = useCallback(() => {
    console.log('CallScreen: Leaving room...')
    // WebSocket で退出を通知
    socketRef.current?.emit('leave-room', {
      roomCode,
      peerId: myPeerIdRef.current,
    })
    // PeerManager の切断処理
    disconnectAll()
    router.push('/')
  }, [roomCode, router])

  return (
    <div className={styles.container}>
      <h1>通話画面</h1>
      <p>あなたの名前: {myName}</p>
      <p>あなたのID: {myPeerId}</p>

      <h2>参加者リスト</h2>
      <ul>
        {Object.entries(userNames)
          // .filter(([id]) => id !== myPeerId) // 自分を表示しない場合
          .map(([id, name]) => (
            <li key={id}>
              {name} {id === myPeerId ? '(あなた)' : ''}{' '}
              {/* ミュート状態を表示 (自分自身は isMuted state を参照) */}
              {id === myPeerId
                ? isMuted
                  ? '🔇'
                  : '🎤'
                : peerMuteMap[id]
                  ? '🔇'
                  : '🎤'}
            </li>
          ))}
      </ul>
      <button
        onClick={toggleMic}
        className={styles.button}
        disabled={!localStreamRef.current}
      >
        {isMuted ? '🔇 ミュート中' : '🎤 ミュート解除'}
      </button>

      <button onClick={leaveRoom} className={styles.button}>
        退出
      </button>
    </div>
  )
}
