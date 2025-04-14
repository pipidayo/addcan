'use client'
import styles from './styles.module.css'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState, useRef, useCallback } from 'react'
import {
  initPeer,
  callPeer,
  disconnectAll,
  sendMuteStatus,
} from '../PeerManager' // PeerManager のインポートは変更なし
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
  // ★★★ 話者状態プロパティを追加 ★★★
  isSpeaking?: boolean
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
  const initializedSocket = useRef(false)
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
    // ... 変更なし ...
    if (!localStreamRef.current) return
    const audioTrack = localStreamRef.current.getAudioTracks()[0]
    if (audioTrack) {
      const newEnabledState = !audioTrack.enabled
      audioTrack.enabled = newEnabledState
      const newMuteState = !newEnabledState
      setIsMuted(newMuteState)
      setParticipants((prev) =>
        prev.map((p) => (p.isSelf ? { ...p, isMuted: newMuteState } : p))
      )
      sendMuteStatus(newMuteState)
      console.log('Mute status sent via PeerManager:', newMuteState)
    }
  }, [])

  const upsertParticipant = useCallback(
    (participantData: Partial<Participant> & { id: string }) => {
      console.log('[upsertParticipant] Data:', participantData)
      console.log('[upsertParticipant] Called with:', participantData)
      setParticipants((prev) => {
        console.log('[upsertParticipant] Previous state:', JSON.stringify(prev))
        const existingIndex = prev.findIndex((p) => p.id === participantData.id)
        let newState
        if (existingIndex > -1) {
          const updatedParticipants = [...prev]
          const existingParticipant = updatedParticipants[existingIndex]
          updatedParticipants[existingIndex] = {
            ...existingParticipant,
            ...participantData,
            isSelf: existingParticipant.isSelf,
          }
          newState = updatedParticipants
        } else {
          // ★★★ isSpeaking の初期値を追加 ★★★
          const newParticipant: Participant = {
            id: participantData.id,
            name: participantData.name || 'Unknown',
            isMuted: participantData.isMuted ?? false,
            isSelf: participantData.isSelf ?? false,
            isSpeaking: participantData.isSpeaking ?? false, // isSpeaking の初期値
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
      // ★★★ audio 要素自体を削除 ★★★
      audio.remove() // document から削除
      delete audioRefs.current[peerId]
      console.log(`CallScreen: Removed audio for peer: ${peerId}`)
    }
  }, [])
  // --- ここまで useCallback フック ---

  // --- メインの useEffect (初期化処理) ---
  useEffect(() => {
    console.log(
      '[CallScreen useEffect] Cleaning up previous connections if any...'
    )
    disconnectAll()

    // --- roomCode と name のチェック (変更なし) ---
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

    // --- Socket 初期化処理 (変更なし) ---
    if (!initializedSocket.current) {
      console.log('CallScreen: Initializing WebSocket connection (once)...')
      const socket = io(WEBSOCKET_SERVER_URL)
      socketRef.current = socket
      initializedSocket.current = true

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
    // --- ここまで Socket 初期化処理 ---

    const socket = socketRef.current
    if (!socket) {
      console.error('CallScreen: Socket instance not found in ref!')
      return
    }

    let isMounted = true
    let currentPeerId = ''

    // --- WebSocket イベントリスナー設定 (変更なし) ---
    const setupWebSocketListeners = (peerIdForSocket: string) => {
      console.log(
        `CallScreen: Setting up other listeners for Peer ID: ${peerIdForSocket}`
      )

      socket.on('user-joined', (payload: UserJoinedPayload) => {
        console.log(
          `[CallScreen] Received 'user-joined' event. Payload:`,
          payload,
          'isMounted:',
          isMounted,
          'currentPeerId:',
          currentPeerId
        )
        const { peerId, name } = payload
        if (!isMounted || peerId === currentPeerId) {
          console.log(
            "[CallScreen] 'user-joined' ignored (self or not mounted)."
          )
          return
        }
        console.log(`CallScreen: User joined: ${name} (${peerId})`)
        upsertParticipant({ id: peerId, name, isMuted: false, isSelf: false })
        console.log(`CallScreen: Attempting to call new peer: ${peerId}`)
        callPeer(peerId).catch((error) => {
          console.error(`CallScreen: Failed to call new peer ${peerId}:`, error)
        })
      })

      socket.on('user-left', (payload: UserLeftPayload) => {
        const { peerId } = payload
        if (!isMounted) return
        console.log(`CallScreen: User left: ${peerId}`)
        // removePeer は onPeerDisconnect で呼ばれる
      })

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
      }
    }
    // --- ここまで WebSocket イベントリスナー設定 ---

    // --- PeerJS の初期化 ---
    const initialize = async () => {
      try {
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
                // ★★★ audio 要素を特定のコンテナに追加 ★★★
                const container = document.getElementById('audio-container')
                if (container) {
                  container.appendChild(audio)
                  console.log(
                    `CallScreen: Appended audio element for ${peerId} to #audio-container`
                  )
                } else {
                  console.warn('#audio-container not found, appending to body.')
                  document.body.appendChild(audio)
                }
                audio
                  .play()
                  .catch((e) => console.error('Audio play failed:', e))
                audioRefs.current[peerId] = audio
              }
            },
            onPeerOpen: (id) => {
              // ... 変更なし ...
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
              setupWebSocketListeners(id)
            },
            onLocalStream: (stream) => {
              // ... 変更なし ...
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
              // ... 変更なし ...
              if (!isMounted) return
              console.log(
                `[CallScreen onReceiveUserName] Received name for peer ${peerId}: "${name}"`
              )
              upsertParticipant({ id: peerId, name })
            },
            onReceiveMuteStatus: (peerId, isMuted) => {
              // ... 変更なし ...
              if (!isMounted) return
              console.log(
                `[CallScreen onReceiveMuteStatus] Received mute status for peer ${peerId}: ${isMuted}`
              )
              upsertParticipant({ id: peerId, isMuted })
            },
            onPeerDisconnect: (peerId) => {
              // ... 変更なし ...
              if (!isMounted) return
              removePeer(peerId)
            },
            // ★★★ 話者検出コールバックを実装 ★★★
            onSpeakingStatusChange: (peerId: string, isSpeaking: boolean) => {
              console.log(
                `[CallScreen onSpeakingStatusChange] Received: Peer ${peerId}, isSpeaking: ${isSpeaking}`
              )
              if (!isMounted) return
              // console.log(`[CallScreen onSpeakingStatusChange] Peer ${peerId} is ${isSpeaking ? 'speaking' : 'not speaking'}`); // デバッグ用
              upsertParticipant({ id: peerId, isSpeaking })
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
    return () => {
      isMounted = false
      console.log('CallScreen: Cleaning up (useEffect dependency change)...')
      // ★★★ オーディオ要素のクリーンアップを改善 ★★★
      Object.values(audioRefs.current).forEach((audio) => {
        audio.pause()
        audio.srcObject = null
        audio.remove() // 要素自体を削除
      })
      audioRefs.current = {}
      localStreamRef.current = null
      myPeerIdRef.current = ''
    }
    // --- ここまでメイン useEffect のクリーンアップ ---

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, router, removePeer, upsertParticipant]) // 依存配列は変更なし
  // --- ここまでメインの useEffect ---

  // --- アンマウント用 useEffect (変更なし) ---
  useEffect(() => {
    return () => {
      console.log(
        'CallScreen: Component unmounting, disconnecting socket and PeerJS.'
      )
      socketRef.current?.disconnect()
      disconnectAll()
      initializedSocket.current = false
      socketRef.current = null
    }
  }, [])
  // --- ここまでアンマウント用 useEffect ---

  // --- 退出処理 (変更なし) ---
  const leaveRoom = useCallback(() => {
    console.log('CallScreen: Leaving room...')
    disconnectAll()
    socketRef.current?.disconnect()
    initializedSocket.current = false
    socketRef.current = null
    router.push('/')
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
        {participants.map((p) => {
          console.log(
            `[CallScreen map] Peer: ${p.id}, isSpeaking: ${p.isSpeaking}`
          )
          return (
            <li
              key={p.id}
              // ★★★ isSpeaking クラスを追加 ★★★
              className={`${styles.participantItem} ${
                p.isSelf ? styles.selfParticipant : ''
              } ${
                p.isSpeaking ? styles.speakingParticipant : '' // isSpeaking 状態に応じてクラスを適用
              }`}
            >
              <span className={styles.participantName}>
                {p.name} {p.isSelf ? '' : ''} {/* '(あなた)' は削除 */}
              </span>
              <span
                className={`${styles.muteIcon} ${p.isMuted ? styles.muted : ''}`}
              >
                {p.isMuted ? '🔇' : '🎤'}
              </span>
            </li>
          )
        })}
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

      {/* ★★★ オーディオ要素を追加するためのコンテナ ★★★ */}
      <div id='audio-container' style={{ display: 'none' }}></div>
    </div>
  )
  // --- ここまで JSX レンダリング ---
}
