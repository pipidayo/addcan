'use client'
import styles from './styles.module.css'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState, useRef, useCallback } from 'react'
import {
  initPeer,
  callPeer,
  disconnectAll,
  sendMuteStatus,
} from '../PeerManager'
import io, { Socket } from 'socket.io-client'
// WebSocket サーバーの URL (環境変数などから取得するのが望ましい)
const WEBSOCKET_SERVER_URL =
  process.env.NEXT_PUBLIC_WEBSOCKET_SERVER_URL || 'http://localhost:3001'
// ↑ 環境変数が設定されていない場合のデフォルト値も指定しておく
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

interface LeaveRoomPayload {
  roomCode: string | undefined
  peerId: string
}

export default function CallScreen() {
  const { room: roomCodeParam } = useParams()
  const roomCode = Array.isArray(roomCodeParam)
    ? roomCodeParam[0]
    : roomCodeParam
  const router = useRouter()
  const socketRef = useRef<Socket | null>(null) // WebSocket のインスタンス

  const [myPeerId, setMyPeerId] = useState('')
  const [myName, setMyName] = useState('')
  const [participants, setParticipants] = useState<Participant[]>([])
  const audioRefs = useRef<{ [id: string]: HTMLAudioElement }>({}) // IDでオーディオ要素を管理
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

  const upsertParticipant = useCallback(
    (participantData: Partial<Participant> & { id: string }) => {
      setParticipants((prev) => {
        const existingIndex = prev.findIndex((p) => p.id === participantData.id)
        if (existingIndex > -1) {
          // 存在する場合は更新
          const updatedParticipants = [...prev]
          updatedParticipants[existingIndex] = {
            ...updatedParticipants[existingIndex],
            ...participantData,
          }
          return updatedParticipants
        } else {
          // 存在しない場合は追加 (isSelf は false がデフォルト、必要なら呼び出し元で指定)
          const newParticipant: Participant = {
            id: participantData.id,
            name: participantData.name || 'Unknown', // 名前がない場合のデフォルト
            isMuted: participantData.isMuted ?? false, // ミュート状態がない場合のデフォルト
            isSelf: participantData.isSelf ?? false,
          }
          return [...prev, newParticipant]
        }
      })
    },
    []
  ) // 依存配列は空

  // ピアが切断されたときに状態から削除する関数
  const removePeer = useCallback((peerId: string) => {
    console.log(`CallScreen: Removing peer: ${peerId}`)
    setParticipants((prev) => prev.filter((p) => p.id !== peerId))

    // オーディオ要素の停止・削除 (変更なし)
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
        const payload: JoinRoomPayload = {
          roomCode,
          peerId: peerIdForSocket,
          name: nameFromStorage,
        }
        socket.emit('join-room', payload)
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
      socket.on('user-joined', (payload: UserJoinedPayload) => {
        const { peerId, name } = payload
        if (!isMounted || peerId === currentPeerId) return // 自分自身は無視
        console.log(`CallScreen: User joined: ${name} (${peerId})`)
        upsertParticipant({ id: peerId, name, isMuted: false, isSelf: false }) // upsertParticipant を使用

        // 新しい参加者に接続 (PeerManager 経由で発信)
        console.log(`CallScreen: Attempting to call new peer: ${peerId}`)
        callPeer(peerId).catch((error) => {
          console.error(
            `CallScreen: Failed to call existing peer ${peerId}:`,
            error
          )
        })
      })

      // 他のユーザーが退出したときのイベント
      socket.on('user-left', (payload: UserLeftPayload) => {
        const { peerId } = payload
        if (!isMounted) return
        console.log(`CallScreen: User left: ${peerId}`)
        // PeerManager 側で handleDisconnect が呼ばれるはずなので、
        // removePeer は onPeerDisconnect コールバックで呼び出す
        // removePeer(peerId); // ここでは呼ばない
      })

      // 既存の参加者リストを取得するイベント
      socket.on(
        'existing-participants',
        (payload: ExistingParticipantsPayload) => {
          if (!isMounted) return
          console.log('CallScreen: Received existing participants:', payload)
          const existingParticipants: Participant[] = Object.entries(payload)
            .filter(([id]) => id !== currentPeerId)
            .map(([id, name]) => ({
              id,
              name,
              isMuted: false,
              isSelf: false,
            }))

          // 自分の情報も participants state に含めるように更新
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
            callPeer(p.id).catch(/* ... */)
          })
        }
      )
    }

    // PeerJS の初期化
    const initialize = async () => {
      try {
        // PeerManager の initPeer を呼び出し

        // const peerId =

        await initPeer(
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

              upsertParticipant({
                //  自分自身を participants に追加
                id,
                name: nameFromStorage,
                isMuted: isMuted, // この時点での isMuted state を参照
                isSelf: true,
              })
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
              upsertParticipant({ id: peerId, name })
            },
            onReceiveMuteStatus: (peerId, isMuted) => {
              if (!isMounted) return
              upsertParticipant({ id: peerId, isMuted })
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
      const payload: LeaveRoomPayload = {
        roomCode,
        peerId: currentPeerIdForCleanup,
      }
      socketRef.current?.emit('leave-room', payload)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, router]) // isMuted は意図的に除外

  // 退出処理
  const leaveRoom = useCallback(() => {
    console.log('CallScreen: Leaving room...')
    const payload: LeaveRoomPayload = {
      roomCode,
      peerId: myPeerIdRef.current,
    }
    // WebSocket で退出を通知
    socketRef.current?.emit('leave-room', payload)
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
        {/* ★ participants state を使ってリストをレンダリング */}
        {participants.map((p) => (
          <li key={p.id}>
            {p.name} {p.isSelf ? '(あなた)' : ''}{' '}
            {/* ★ isMuted プロパティを参照 */}
            {p.isMuted ? '🔇' : '🎤'}
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
