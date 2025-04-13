'use client'
import styles from './styles.module.css'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState, useRef, useCallback } from 'react'
import {
  initPeer,
  callPeer,
  disconnectAll, // disconnectAll をインポート
  sendMuteStatus,
} from '../PeerManager'
import io, { Socket } from 'socket.io-client'

// WebSocket サーバーの URL
const WEBSOCKET_SERVER_URL =
  process.env.NEXT_PUBLIC_WEBSOCKET_SERVER_URL || 'http://localhost:3001'

// --- インターフェース定義 ---
interface Participant {
  id: string
  name: string
  isMuted: boolean
  isSelf: boolean
}
interface UserJoinedPayload {
  peerId: string
  name: string
}
interface UserLeftPayload {
  peerId: string
}
interface ExistingParticipantsPayload {
  [id: string]: string
}
interface JoinRoomPayload {
  roomCode: string | undefined
  peerId: string
  name: string
}

// --- ここまでインターフェース定義 ---

export default function CallScreen() {
  const { room: roomCodeParam } = useParams()
  const roomCode = Array.isArray(roomCodeParam)
    ? roomCodeParam[0]
    : roomCodeParam
  const router = useRouter()

  // --- State と Ref 定義 ---
  const socketRef = useRef<Socket | null>(null)
  const initializedSocket = useRef(false) // Socket初期化済みフラグ
  const [myPeerId, setMyPeerId] = useState('')
  const [myName, setMyName] = useState('')
  const [participants, setParticipants] = useState<Participant[]>([])
  const audioRefs = useRef<{ [id: string]: HTMLAudioElement }>({})
  const [isMuted, setIsMuted] = useState(false)
  const localStreamRef = useRef<MediaStream | null>(null)
  const myPeerIdRef = useRef<string>('')
  // --- ここまで State と Ref 定義 ---

  // --- useCallback フック ---
  const toggleMic = useCallback(() => {
    if (!localStreamRef.current) return
    const audioTrack = localStreamRef.current.getAudioTracks()[0]
    if (audioTrack) {
      const newEnabledState = !audioTrack.enabled
      audioTrack.enabled = newEnabledState
      const newMuteState = !newEnabledState
      setIsMuted(newMuteState)
      // ★★★ participants state 内の自分自身の isMuted も更新 ★★★
      setParticipants((prev) =>
        prev.map((p) => (p.isSelf ? { ...p, isMuted: newMuteState } : p))
      )

      sendMuteStatus(newMuteState)
      console.log('Mute status sent via PeerManager:', newMuteState)
    }
  }, [])

  const upsertParticipant = useCallback(
    (participantData: Partial<Participant> & { id: string }) => {
      console.log('[upsertParticipant] Called with:', participantData)
      setParticipants((prev) => {
        console.log('[upsertParticipant] Previous state:', JSON.stringify(prev))
        const existingIndex = prev.findIndex((p) => p.id === participantData.id)
        let newState
        if (existingIndex > -1) {
          const updatedParticipants = [...prev]
          // ★★★ 更新時に isSelf は上書きしないように修正 ★★
          const existingParticipant = updatedParticipants[existingIndex]
          updatedParticipants[existingIndex] = {
            ...existingParticipant, // 既存の値をベースにする
            ...participantData, // 新しい値で上書き
            isSelf: existingParticipant.isSelf, // isSelf は既存の値を維持する
          }
          newState = updatedParticipants
        } else {
          // 新規追加の場合 (変更なし)
          const newParticipant: Participant = {
            id: participantData.id,
            name: participantData.name || 'Unknown',
            isMuted: participantData.isMuted ?? false,
            isSelf: participantData.isSelf ?? false, // isSelf は participantData に依存
          }
          newState = [...prev, newParticipant]
        }
        console.log('[upsertParticipant] New state:', JSON.stringify(newState))
        return newState
      })
    },
    []
  )

  const removePeer = useCallback((peerId: string) => {
    console.log(`CallScreen: Removing peer: ${peerId}`)
    setParticipants((prev) => prev.filter((p) => p.id !== peerId))
    if (audioRefs.current[peerId]) {
      const audio = audioRefs.current[peerId]
      audio.pause()
      audio.srcObject = null
      delete audioRefs.current[peerId]
      console.log(`CallScreen: Removed audio for peer: ${peerId}`)
    }
  }, [])
  // --- ここまで useCallback フック ---

  // --- メインの useEffect (初期化処理) ---
  useEffect(() => {
    // ★★★ useEffect の最初に前回の接続をクリーンアップ ★★★
    console.log(
      '[CallScreen useEffect] Cleaning up previous connections if any...'
    )
    disconnectAll() // PeerJS の状態をリセット
    // ★★★ ここまで追加 ★★★

    // --- roomCode と name のチェック ---
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
    // --- ここまで roomCode と name のチェック ---

    // ★★★ Socket インスタンスの生成と基本リスナー設定 (初回のみ) ★★★
    if (!initializedSocket.current) {
      console.log('CallScreen: Initializing WebSocket connection (once)...')
      const socket = io(WEBSOCKET_SERVER_URL)
      socketRef.current = socket
      initializedSocket.current = true // 初期化済みフラグを立てる

      // ★★★ 基本的なリスナーはここで設定 ★★★
      socket.on('connect', () => {
        console.log(
          '★★★ CallScreen: WebSocket connected! Socket ID:',
          socket.id
        )
      })
      socket.on('connect_error', (error) => {
        console.error('CallScreen: WebSocket connection error:', error)
        alert('サーバーとの接続に失敗しました。')
      })
      socket.on('disconnect', (reason) => {
        console.log('CallScreen: WebSocket disconnected:', reason)
      })
    }
    // ★★★ ここまで Socket 初期化処理 ★★★

    const socket = socketRef.current // ref から socket を取得
    if (!socket) {
      console.error('CallScreen: Socket instance not found in ref!')
      return // socket がなければ処理中断
    }

    let isMounted = true // コールバック内で使うためのフラグ
    let currentPeerId = '' // ローカル変数

    // --- WebSocket イベントリスナー設定 (connect, connect_error, disconnect 以外) ---
    const setupWebSocketListeners = (peerIdForSocket: string) => {
      console.log(
        `CallScreen: Setting up other listeners for Peer ID: ${peerIdForSocket}`
      )

      // 他のユーザーが参加したときのイベント
      socket.on('user-joined', (payload: UserJoinedPayload) => {
        console.log(
          `[CallScreen] Received 'user-joined' event. Payload:`,
          payload,
          'isMounted:',
          isMounted,
          'currentPeerId:',
          currentPeerId
        ) // ログ追加
        const { peerId, name } = payload
        if (!isMounted || peerId === currentPeerId) {
          console.log(
            "[CallScreen] 'user-joined' ignored (self or not mounted)."
          ) // ログ追加
          return
        }
        console.log(`CallScreen: User joined: ${name} (${peerId})`)
        upsertParticipant({ id: peerId, name, isMuted: false, isSelf: false })
        console.log(`CallScreen: Attempting to call new peer: ${peerId}`)
        callPeer(peerId).catch((error) => {
          console.error(`CallScreen: Failed to call new peer ${peerId}:`, error)
        })
      })

      // 他のユーザーが退出したときのイベント
      socket.on('user-left', (payload: UserLeftPayload) => {
        const { peerId } = payload
        if (!isMounted) return
        console.log(`CallScreen: User left: ${peerId}`)
        // removePeer は onPeerDisconnect で呼ばれる
      })

      // 既存の参加者リストを取得するイベント
      socket.on(
        'existing-participants',
        (payload: ExistingParticipantsPayload) => {
          if (!isMounted) return
          console.log('CallScreen: Received existing participants:', payload)
          const existingParticipants: Participant[] = Object.entries(payload)
            .filter(([id]) => id !== currentPeerId)
            .map(([id, name]) => ({ id, name, isMuted: false, isSelf: false }))

          setParticipants((prev) => {
            const self = prev.find((p) => p.isSelf)
            const combined = self ? [self] : []
            existingParticipants.forEach((p) => {
              if (!combined.some((cp) => cp.id === p.id)) {
                combined.push(p)
              }
            })
            return combined
          })

          existingParticipants.forEach((p) => {
            console.log(`CallScreen: Attempting to call existing peer: ${p.id}`)
            callPeer(p.id).catch((error) => {
              console.error(
                `CallScreen: Failed to call existing peer ${p.id}:`,
                error
              )
            })
          })
        }
      )

      //  接続が確立していて Peer ID も確定したら join-room を emit
      if (socket.connected && peerIdForSocket) {
        console.log(
          `CallScreen: Emitting join-room (from setupWebSocketListeners) with peerId: ${peerIdForSocket}`
        )
        const payload: JoinRoomPayload = {
          roomCode,
          peerId: peerIdForSocket,
          name: nameFromStorage!,
        }
        socket.emit('join-room', payload)
      } else {
        console.warn(
          'CallScreen: Cannot emit join-room yet. Socket connected:',
          socket.connected,
          'Peer ID:',
          peerIdForSocket
        )
        // 接続がまだなら、'connect' イベント内で再度 emit を試みるロジックが必要になる場合がある
        // (ただし、今回の修正で 'connect' は Peer ID 確定前に発生する可能性が高い)
      }
    }
    // --- ここまで WebSocket イベントリスナー設定 ---

    // --- PeerJS の初期化 ---
    const initialize = async () => {
      try {
        // ★★★ initPeer を呼び出す (内部での disconnectAll は削除済み) ★★★
        // initPeer に渡す直前の nameFromStorage をログ出力
        console.log(
          `[CallScreen initialize] Calling initPeer with name: "${nameFromStorage!}"`
        )
        await initPeer(
          {
            roomCode: roomCode,
            onReceiveStream: (stream, peerId) => {
              if (!isMounted) return
              console.log(`CallScreen: Received stream from ${peerId}`)
              if (!audioRefs.current[peerId]) {
                const audio = new Audio()
                audio.srcObject = stream
                audio.dataset.peerId = peerId
                console.log(
                  `CallScreen: Appending audio element for ${peerId} to document body`
                ) // ログ追加
                document.body.appendChild(audio)
                audio
                  .play()
                  .catch((e) => console.error('Audio play failed:', e))
                audioRefs.current[peerId] = audio
              }
            },
            onPeerOpen: (id) => {
              if (!isMounted) return
              console.log('CallScreen: Peer opened with ID:', id)
              currentPeerId = id
              setMyPeerId(id)
              myPeerIdRef.current = id

              upsertParticipant({
                id,
                name: nameFromStorage!,
                isMuted: isMuted,
                isSelf: true,
              })

              // ★★★ setupWebSocketListeners を呼ぶ (ここで join-room が emit されるはず) ★★★
              setupWebSocketListeners(id)
            },
            onLocalStream: (stream) => {
              if (!isMounted) return
              console.log('CallScreen: Local stream obtained.')
              localStreamRef.current = stream
              const audioTrack = stream.getAudioTracks()[0]
              if (audioTrack) {
                const initialMuteState = isMuted
                audioTrack.enabled = !initialMuteState
                setParticipants((prev) =>
                  prev.map((p) =>
                    p.isSelf ? { ...p, isMuted: initialMuteState } : p
                  )
                )
              }
            },
            onReceiveUserName: (peerId, name) => {
              if (!isMounted) return
              // ★★★ チェックを削除し、常に upsertParticipant を呼ぶ ★★★
              console.log(
                `[CallScreen onReceiveUserName] Received name for peer ${peerId}: "${name}"`
              )
              upsertParticipant({ id: peerId, name })
            },

            onReceiveMuteStatus: (peerId, isMuted) => {
              if (!isMounted) return
              // ★★★ チェックを削除し、常に upsertParticipant を呼ぶ ★★★
              console.log(
                `[CallScreen onReceiveMuteStatus] Received mute status for peer ${peerId}: ${isMuted}`
              )
              upsertParticipant({ id: peerId, isMuted })
            },
            onPeerDisconnect: (peerId) => {
              if (!isMounted) return
              removePeer(peerId)
            },
          },
          nameFromStorage!,
          isMuted
        )
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
    // --- ここまで PeerJS の初期化 ---

    // --- メイン useEffect のクリーンアップ関数 ---
    // 主に isMounted フラグのリセットやオーディオ要素のクリーンアップを行う
    return () => {
      isMounted = false // コールバック内での処理を停止させる
      console.log('CallScreen: Cleaning up (useEffect dependency change)...')

      // PeerManager の切断処理はアンマウント用 useEffect で行う
      // disconnectAll() // ★★★ ここでは呼び出さない ★★★

      // オーディオ要素を停止・削除
      Object.values(audioRefs.current).forEach((audio) => {
        audio.pause()
        audio.srcObject = null
      })
      audioRefs.current = {}
      localStreamRef.current = null // ローカルストリームの参照をクリア
      myPeerIdRef.current = '' // Peer ID の参照をクリア

      // WebSocket の disconnect もアンマウント用 useEffect で行う
    }
    // --- ここまでメイン useEffect のクリーンアップ ---

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, router, removePeer, upsertParticipant]) // 依存配列は変更なし
  // --- ここまでメインの useEffect ---

  // ★★★ コンポーネントアンマウント時に確実に切断するための useEffect ★★★
  useEffect(() => {
    return () => {
      console.log(
        'CallScreen: Component unmounting, disconnecting socket and PeerJS.'
      )
      socketRef.current?.disconnect() // WebSocket 接続を切断
      disconnectAll() // ★★★ PeerJS 接続を切断 ★★★
      initializedSocket.current = false // 次回マウント時に再接続できるようにフラグをリセット
      socketRef.current = null // ref もクリア
    }
  }, []) // 空の依存配列で、アンマウント時にのみ実行
  // ★★★ ここまでアンマウント用 useEffect ★★★

  // --- 退出処理 ---
  const leaveRoom = useCallback(() => {
    console.log('CallScreen: Leaving room...')
    // WebSocket で退出を通知 (サーバー側で処理するなら必要)
    // const payload: LeaveRoomPayload = { roomCode, peerId: myPeerIdRef.current };
    // socketRef.current?.emit('leave-room', payload);

    // PeerJS と WebSocket の接続を切断 (アンマウント用 useEffect で行われるが、即時実行)
    disconnectAll()
    socketRef.current?.disconnect()
    initializedSocket.current = false
    socketRef.current = null

    router.push('/') // ホーム画面に戻る
  }, [router])
  // --- ここまで退出処理 ---

  // --- JSX レンダリング ---
  return (
    <div className={styles.container}>
      <h1>通話画面</h1>
      <p>あなたの名前: {myName}</p>
      <p>あなたのID: {myPeerId}</p>

      <h2>参加者リスト</h2>
      <ul className={styles.participantList}>
        {participants.map((p) => (
          <li
            key={p.id}
            // isSelf に応じてスタイルを適用
            className={`${styles.participantItem} ${
              p.isSelf ? styles.selfParticipant : ''
            }`}
          >
            <span className={styles.participantName}>
              {p.name} {p.isSelf ? '' : ''}
            </span>

            <span
              className={`${styles.muteIcon} ${p.isMuted ? styles.muted : ''}`}
            >
              {p.isMuted ? '🔇' : '🎤'}
            </span>
            {/* )} */}
          </li>
        ))}
      </ul>
      <button
        onClick={toggleMic}
        className={styles.button}
        disabled={!localStreamRef.current} // ローカルストリームが取得できたら有効化
      >
        {isMuted ? '🔇 ミュート中' : '🎤 ミュート解除'}
      </button>

      <button onClick={leaveRoom} className={styles.button}>
        退出
      </button>
    </div>
  )
  // --- ここまで JSX レンダリング ---
}
