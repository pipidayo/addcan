// src/app/components/CallScreen/index.tsx
'use client'
import styles from './styles.module.css'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState, useRef, useCallback } from 'react'
import {
  initPeer,
  callPeer,
  disconnectAll,
  sendMuteStatus,
  switchMicrophone,
  startScreenShare,
  stopScreenShare,
  type InitPeerOptions, // ★ 型をインポート
} from '../PeerManager'
import io, { Socket } from 'socket.io-client'
// ★★★ フッターコンポーネントをインポート ★★★
import CallControlsFooter from '../CallControlsFooter' // パスを確認してください
// ★ 任意: アイコンを使う場合
// import { ComputerDesktopIcon, StopCircleIcon } from '@heroicons/react/24/outline';

// WebSocket サーバーの URL
const WEBSOCKET_SERVER_URL =
  process.env.NEXT_PUBLIC_WEBSOCKET_SERVER_URL || 'http://localhost:3001'

// --- インターフェース定義 ---
interface Participant {
  id: string
  name: string
  isMuted: boolean
  isSelf: boolean
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

interface LocalAudioAnalysisRefs {
  context: AudioContext | null
  analyser: AnalyserNode | null
  source: MediaStreamAudioSourceNode | null
  animationFrameId: number | null
  dataArray: Uint8Array | null
  isSpeaking: boolean // 最後に検出された状態
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
  const [myPeerId, setMyPeerId] = useState('')
  const [myName, setMyName] = useState('')
  const [participants, setParticipants] = useState<Participant[]>([])
  const audioRefs = useRef<{ [id: string]: HTMLAudioElement }>({})
  const [isMuted, setIsMuted] = useState(false)
  const localStreamRef = useRef<MediaStream | null>(null)
  const myPeerIdRef = useRef<string>('')
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([])
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([])
  const [selectedMicId, setSelectedMicId] = useState<string>('')
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string>('')
  const localAudioAnalysis = useRef<LocalAudioAnalysisRefs>({
    context: null,
    analyser: null,
    source: null,
    animationFrameId: null,
    dataArray: null,
    isSpeaking: false,
  })
  const [participantVolumes, setParticipantVolumes] = useState<{
    [id: string]: number
  }>({})
  const localSpeakingThreshold = 10

  const [isScreenSharing, setIsScreenSharing] = useState(false) // 自分が共有中か
  const [screenSharingPeerId, setScreenSharingPeerId] = useState<string | null>(
    null
  )
  // ★★★ 画面共有表示用の State と Ref を追加 ★★★
  const screenVideoRef = useRef<HTMLVideoElement>(null)
  const [screenShareStream, setScreenShareStream] =
    useState<MediaStream | null>(null)

  // --- ここまで State と Ref 定義 ---

  // 音量変更ハンドラ
  const handleVolumeChange = (peerId: string, volume: number) => {
    setParticipantVolumes((prev) => ({ ...prev, [peerId]: volume }))
    const audioElement = audioRefs.current[peerId]
    if (audioElement) {
      audioElement.volume = volume
    }
  }

  // デバイスリスト取得関数
  const getDevices = useCallback(async () => {
    try {
      const dummyStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      })
      dummyStream.getTracks().forEach((track) => track.stop())
      console.log(
        'CallScreen: Dummy stream acquired and stopped for device enumeration.'
      )

      const devices = await navigator.mediaDevices.enumerateDevices()
      const audioInputDevices = devices.filter((d) => d.kind === 'audioinput')
      const audioOutputDevices = devices.filter((d) => d.kind === 'audiooutput')
      setMicrophones(audioInputDevices)
      setSpeakers(audioOutputDevices)

      const currentMic = localStreamRef.current
        ?.getAudioTracks()[0]
        ?.getSettings().deviceId
      if (
        currentMic &&
        audioInputDevices.some((d) => d.deviceId === currentMic)
      ) {
        setSelectedMicId(currentMic)
      } else if (audioInputDevices.length > 0) {
        setSelectedMicId(audioInputDevices[0].deviceId)
      }

      const defaultSpeaker = audioOutputDevices.find(
        (d) => d.deviceId === 'default'
      )
      if (defaultSpeaker) {
        setSelectedSpeakerId(defaultSpeaker.deviceId)
      } else if (audioOutputDevices.length > 0) {
        setSelectedSpeakerId(audioOutputDevices[0].deviceId)
      }
      console.log('Available microphones:', audioInputDevices)
      console.log('Available speakers:', audioOutputDevices)
    } catch (err) {
      console.error('Error enumerating devices:', err)
    }
  }, [])

  // stopLocalAudioAnalysis
  const stopLocalAudioAnalysis = useCallback(() => {
    const analysis = localAudioAnalysis.current
    if (analysis.animationFrameId !== null) {
      cancelAnimationFrame(analysis.animationFrameId)
      analysis.animationFrameId = null
    }
    try {
      analysis.source?.disconnect()
    } catch {
      /* ignore */
    }
    if (analysis.context?.state !== 'closed') {
      analysis.context
        ?.close()
        .catch((e) => console.error('Error closing local AudioContext:', e))
    }
    localAudioAnalysis.current = {
      context: null,
      analyser: null,
      source: null,
      animationFrameId: null,
      dataArray: null,
      isSpeaking: false,
    }
    console.log('CallScreen: Stopped local audio analysis.')
    if (myPeerIdRef.current) {
      setParticipants((prev) =>
        prev.map((p) =>
          p.id === myPeerIdRef.current ? { ...p, isSpeaking: false } : p
        )
      )
    }
  }, [])

  // upsertParticipant
  const upsertParticipant = useCallback(
    (participantData: Partial<Participant> & { id: string }) => {
      setParticipants((prev) => {
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
          const newParticipant: Participant = {
            id: participantData.id,
            name: participantData.name || 'Unknown',
            isMuted: participantData.isMuted ?? false,
            isSelf: participantData.isSelf ?? false,
            isSpeaking: participantData.isSpeaking ?? false,
          }
          newState = [...prev, newParticipant]
        }
        return newState
      })
    },
    []
  )

  // startLocalAudioAnalysis
  const startLocalAudioAnalysis = useCallback(
    (stream: MediaStream) => {
      stopLocalAudioAnalysis()

      const audioTracks = stream.getAudioTracks()
      if (audioTracks.length === 0 || !audioTracks[0].enabled) {
        console.warn(
          'CallScreen: Local audio track not available or disabled for analysis.'
        )
        return
      }

      try {
        const context = new AudioContext()
        const source = context.createMediaStreamSource(stream)
        const analyser = context.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.3
        source.connect(analyser)
        const dataArray = new Uint8Array(analyser.frequencyBinCount)

        localAudioAnalysis.current = {
          context,
          analyser,
          source,
          animationFrameId: null,
          dataArray,
          isSpeaking: false,
        }

        const analyse = () => {
          const analysis = localAudioAnalysis.current
          if (
            !analysis.analyser ||
            !analysis.dataArray ||
            !analysis.context || // ← context が null でないか確認
            analysis.context.state !== 'running'
          ) {
            if (analysis.animationFrameId)
              cancelAnimationFrame(analysis.animationFrameId)
            analysis.animationFrameId = null
            return
          }

          analysis.animationFrameId = requestAnimationFrame(analyse)
          analysis.analyser.getByteFrequencyData(analysis.dataArray)

          let sum = 0
          for (let i = 0; i < analysis.dataArray.length; i++) {
            sum += analysis.dataArray[i]
          }
          const average = sum / analysis.dataArray.length
          const isSpeaking = average > localSpeakingThreshold

          if (isSpeaking !== analysis.isSpeaking) {
            analysis.isSpeaking = isSpeaking
            if (myPeerIdRef.current) {
              setParticipants((prev) =>
                prev.map((p) =>
                  p.id === myPeerIdRef.current ? { ...p, isSpeaking } : p
                )
              )
            }
          }
        }
        analyse()
        console.log('CallScreen: Started local audio analysis.')
      } catch (error) {
        console.error('CallScreen: Error starting local audio analysis:', error)
        stopLocalAudioAnalysis()
      }
    },
    [localSpeakingThreshold, stopLocalAudioAnalysis]
  )

  // handleMicChange
  const handleMicChange = useCallback(
    async (event: React.ChangeEvent<HTMLSelectElement>) => {
      const newMicId = event.target.value
      const currentMicId = selectedMicId
      console.log('Selected Microphone ID:', newMicId)
      setSelectedMicId(newMicId)

      try {
        stopLocalAudioAnalysis()
        await switchMicrophone(newMicId)
        console.log('Microphone switched successfully in PeerManager')
        setTimeout(() => {
          if (localStreamRef.current) {
            startLocalAudioAnalysis(localStreamRef.current)
          }
        }, 500)
      } catch (error) {
        console.error('Failed to switch microphone:', error)
        alert(
          `マイクの切り替えに失敗しました: ${error instanceof Error ? error.message : String(error)}`
        )
        setSelectedMicId(currentMicId)
        if (localStreamRef.current) {
          startLocalAudioAnalysis(localStreamRef.current)
        }
      }
    },
    [selectedMicId, startLocalAudioAnalysis, stopLocalAudioAnalysis]
  )

  // handleSpeakerChange
  const handleSpeakerChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const newSpeakerId = event.target.value
      console.log('Selected Speaker ID:', newSpeakerId)
      setSelectedSpeakerId(newSpeakerId)

      Object.values(audioRefs.current).forEach(async (audioElement) => {
        if (audioElement && typeof audioElement.setSinkId === 'function') {
          try {
            await audioElement.setSinkId(newSpeakerId)
            console.log(`Set sinkId for audio element to ${newSpeakerId}`)
          } catch (err) {
            console.error('Error setting sinkId:', err)
          }
        }
      })
    },
    []
  )

  // toggleMic
  const toggleMic = useCallback(() => {
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

  // removePeer
  const removePeer = useCallback(
    (peerId: string) => {
      console.log(`CallScreen: Removing peer: ${peerId}`)
      setParticipants((prev) => prev.filter((p) => p.id !== peerId))
      if (audioRefs.current[peerId]) {
        const audio = audioRefs.current[peerId]
        audio.pause()
        audio.srcObject = null
        audio.remove()
        delete audioRefs.current[peerId]
        console.log(`CallScreen: Removed audio for peer: ${peerId}`)
      }
      setScreenSharingPeerId((prevSharerId) => {
        if (prevSharerId === peerId) {
          console.log(
            `CallScreen: Screen sharer ${peerId} disconnected, clearing stream.`
          )
          if (screenShareStream) {
            screenShareStream.getTracks().forEach((track) => track.stop())
          }
          setScreenShareStream(null)
          if (screenVideoRef.current) {
            screenVideoRef.current.srcObject = null
          }
          return null
        }
        return prevSharerId
      })
    },
    [screenShareStream]
  )

  // toggleScreenShare
  const toggleScreenShare = useCallback(async () => {
    if (isScreenSharing) {
      try {
        await stopScreenShare()
        setIsScreenSharing(false)
        console.log('CallScreen: Screen sharing stopped.')
      } catch (error) {
        console.error('CallScreen: Failed to stop screen share:', error)
        alert(
          `画面共有の停止に失敗しました: ${error instanceof Error ? error.message : String(error)}`
        )
        setIsScreenSharing(false)
      }
    } else {
      try {
        if (
          screenSharingPeerId &&
          screenSharingPeerId !== myPeerIdRef.current
        ) {
          const sharerName =
            participants.find((p) => p.id === screenSharingPeerId)?.name ||
            '他の参加者'
          console.log(`Starting screen share, taking over from ${sharerName}`)
        }
        await startScreenShare()
        setIsScreenSharing(true)
        console.log('CallScreen: Screen sharing started.')
      } catch (error) {
        console.error('CallScreen: Failed to start screen share:', error)
        if (error instanceof Error && error.name !== 'NotAllowedError') {
          alert(`画面共有の開始に失敗しました: ${error.message}`)
        }
        setIsScreenSharing(false)
      }
    }
  }, [isScreenSharing, screenSharingPeerId, participants])

  // leaveRoom
  const leaveRoom = useCallback(() => {
    console.log('CallScreen: Leaving room...')
    router.push('/')
  }, [router])

  // --- メインの useEffect (初期化処理) ---
  useEffect(() => {
    console.log('[CallScreen useEffect] Initializing...')

    // --- roomCode と name のチェック ---
    if (!roomCode) {
      router.push('/')
      alert('ルームコードがありません')
      return
    }
    const nameFromStorage = localStorage.getItem('my_name')
    if (!nameFromStorage) {
      router.push('/')
      alert('名前が設定されていません')
      return
    }
    if (!myName) setMyName(nameFromStorage)
    // --- ここまで ---

    let isMounted = true
    let cleanupWebSocketListeners: (() => void) | null = null

    // --- WebSocket イベントリスナー設定 ---
    const setupWebSocketListeners = (
      currentSocket: Socket,
      peerIdForSocket: string
    ) => {
      console.log(
        `CallScreen: Setting up WebSocket listeners for Peer ID: ${peerIdForSocket}`
      )

      const handleUserJoined = (payload: UserJoinedPayload) => {
        const { peerId, name } = payload
        if (!isMounted || peerId === myPeerIdRef.current) return
        console.log(`CallScreen: User joined: ${name} (${peerId})`)
        upsertParticipant({ id: peerId, name, isMuted: false, isSelf: false })
        callPeer(peerId).catch((error) =>
          console.error(`CallScreen: Failed to call new peer ${peerId}:`, error)
        )
      }
      const handleUserLeft = (payload: UserLeftPayload) => {
        if (!isMounted) return
        console.log(`CallScreen: User left: ${payload.peerId}`)
      }
      const handleExistingParticipants = (
        payload: ExistingParticipantsPayload
      ) => {
        if (!isMounted) return
        console.log('CallScreen: Received existing participants:', payload)
        const existingParticipants: Participant[] = Object.entries(payload)
          .filter(([id]) => id !== myPeerIdRef.current)
          .map(([id, name]) => ({ id, name, isMuted: false, isSelf: false }))
        setParticipants((prev) => {
          const self = prev.find((p) => p.isSelf)
          const combined = self ? [self] : []
          const existingIds = new Set(combined.map((p) => p.id))
          existingParticipants.forEach((p) => {
            if (!existingIds.has(p.id)) {
              combined.push(p)
              existingIds.add(p.id)
            }
          })
          return combined
        })
        existingParticipants.forEach((p) => {
          callPeer(p.id).catch((error) =>
            console.error(
              `CallScreen: Failed to call existing peer ${p.id}:`,
              error
            )
          )
        })
      }

      currentSocket.on('user-joined', handleUserJoined)
      currentSocket.on('user-left', handleUserLeft)
      currentSocket.on('existing-participants', handleExistingParticipants)

      return () => {
        // クリーンアップ関数
        console.log(
          `CallScreen: Removing WebSocket listeners for Peer ID: ${peerIdForSocket}`
        )
        currentSocket.off('user-joined', handleUserJoined)
        currentSocket.off('user-left', handleUserLeft)
        currentSocket.off('existing-participants', handleExistingParticipants)
      }
    }
    // --- ここまで WebSocket イベントリスナー設定 ---

    // ★★★ initializePeer 関数の定義をここに移動 ★★★
    const initializePeer = async (
      currentSocket: Socket,
      currentMyName: string
    ) => {
      if (myPeerIdRef.current) {
        console.log('CallScreen: PeerJS already initialized.')
        return
      }

      try {
        await getDevices()
        const currentIsMuted = isMuted
        console.log(
          `[CallScreen initializePeer] Calling initPeer with name: "${currentMyName}"`
        )

        const peerOptions: InitPeerOptions = {
          roomCode: roomCode,
          // ★ 音声ストリーム受信
          onReceiveStream: (stream: MediaStream, peerId: string) => {
            if (!isMounted) return
            if (!audioRefs.current[peerId]) {
              const audio = new Audio()
              audio.srcObject = stream
              audio.dataset.peerId = peerId
              const container = document.getElementById('audio-container')
              if (container) container.appendChild(audio)
              else document.body.appendChild(audio)
              audio.play().catch((e) => console.error('Audio play failed:', e))
              audioRefs.current[peerId] = audio
              handleVolumeChange(peerId, participantVolumes[peerId] ?? 1.0)
              if (selectedSpeakerId && typeof audio.setSinkId === 'function') {
                audio
                  .setSinkId(selectedSpeakerId)
                  .catch((err) =>
                    console.error('Failed to set sinkId on new audio:', err)
                  )
              }
            }
          },
          // ★★★ 画面共有ストリーム受信コールバックを追加 ★★★
          onReceiveScreenStream: (stream: MediaStream, peerId: string) => {
            if (!isMounted) return
            console.log(
              `CallScreen: Received screen share stream from ${peerId}`
            )
            if (screenShareStream) {
              console.log(
                'Stopping previous screen share stream before setting new one.'
              )
              screenShareStream.getTracks().forEach((track) => track.stop())
            }
            setScreenShareStream(stream)
            if (screenVideoRef.current) {
              screenVideoRef.current.srcObject = stream
              screenVideoRef.current
                .play()
                .catch((e) =>
                  console.error('Screen share video play failed:', e)
                )
              console.log(
                `CallScreen: Set screen share stream to video element for ${peerId}`
              )
            } else {
              console.warn('Screen share video element ref not found.')
            }
          },
          // ★ PeerJS 接続確立
          onPeerOpen: (id: string) => {
            if (!isMounted) return
            console.log('CallScreen: Peer opened with ID:', id)
            setMyPeerId(id)
            myPeerIdRef.current = id
            upsertParticipant({
              id,
              name: currentMyName,
              isMuted: currentIsMuted,
              isSelf: true,
            })
            cleanupWebSocketListeners = setupWebSocketListeners(
              currentSocket,
              id
            )
            if (currentSocket.connected) {
              console.log(
                `CallScreen: Emitting join-room (from onPeerOpen) with peerId: ${id}`
              )
              const payload: JoinRoomPayload = {
                roomCode,
                peerId: id,
                name: currentMyName,
              }
              currentSocket.emit('join-room', payload)
            }
          },
          // ★ ローカルメディアストリーム取得
          onLocalStream: (stream: MediaStream) => {
            // ★ 型指定済み
            if (!isMounted) return
            console.log('CallScreen: Local stream obtained.')
            localStreamRef.current = stream
            const audioTrack = stream.getAudioTracks()[0]
            if (audioTrack) {
              audioTrack.enabled = !currentIsMuted
              startLocalAudioAnalysis(stream)
            }
          },
          // ★ 参加者名受信
          onReceiveUserName: (peerId: string, name: string) => {
            if (!isMounted) return
            upsertParticipant({ id: peerId, name })
          },
          // ★ ミュート状態受信
          onReceiveMuteStatus: (peerId: string, isMutedStatus: boolean) => {
            if (!isMounted) return
            upsertParticipant({ id: peerId, isMuted: isMutedStatus })
          },
          // ★ 参加者切断
          onPeerDisconnect: (peerId: string) => {
            if (!isMounted) return
            removePeer(peerId)
          },
          // ★ 話者検出状態受信
          onSpeakingStatusChange: (peerId: string, isSpeaking: boolean) => {
            // ★ 型指定済み
            if (!isMounted) return
            upsertParticipant({ id: peerId, isSpeaking })
          },
          // ★★★ 画面共有状態受信コールバック (クリア処理を追加) ★★★
          onReceiveScreenShareStatus: (peerId: string, isSharing: boolean) => {
            // ★ 型指定済み
            if (!isMounted) return
            console.log(
              `[CallScreen] Received screen share status from ${peerId}: ${isSharing}`
            )
            if (isSharing) {
              setScreenSharingPeerId((prevSharerId) => {
                if (prevSharerId !== peerId) {
                  if (prevSharerId === myPeerIdRef.current) {
                    console.warn(
                      `Peer ${peerId} started sharing, stopping local screen share.`
                    )
                    stopScreenShare().catch((err) =>
                      console.error(
                        'Error stopping local share on conflict:',
                        err
                      )
                    )
                    setIsScreenSharing(false)
                  }
                  if (screenShareStream) {
                    console.log(
                      'Clearing previous screen share stream as sharer changed.'
                    )
                    screenShareStream
                      .getTracks()
                      .forEach((track) => track.stop())
                    setScreenShareStream(null)
                    if (screenVideoRef.current) {
                      screenVideoRef.current.srcObject = null
                    }
                  }
                }
                return peerId
              })
            } else {
              setScreenSharingPeerId((prevSharerId) => {
                if (prevSharerId === peerId) {
                  console.log(
                    `CallScreen: Peer ${peerId} stopped screen sharing, clearing stream.`
                  )
                  if (screenShareStream) {
                    screenShareStream
                      .getTracks()
                      .forEach((track) => track.stop())
                  }
                  setScreenShareStream(null)
                  if (screenVideoRef.current) {
                    screenVideoRef.current.srcObject = null
                  }
                  return null
                }
                return prevSharerId
              })
            }
          },
        } // ここまで peerOptions
        await initPeer(peerOptions, currentMyName, currentIsMuted)
      } catch (error) {
        console.error('CallScreen: PeerJS initialization failed:', error)
        if (isMounted) alert('通話機能の初期化に失敗しました。')
      }
    } // ここまで initializePeer

    // --- Socket 初期化 & 接続 ---
    let socket: Socket | null = socketRef.current
    if (!socket || !socket.connected) {
      socket?.disconnect()
      console.log('CallScreen: Initializing WebSocket connection...')
      socket = io(WEBSOCKET_SERVER_URL)
      socketRef.current = socket

      socket.on('connect', () => {
        console.log(
          '★★★ CallScreen: WebSocket connected! Socket ID:',
          socket?.id
        )
        initializePeer(socket!, nameFromStorage) // connect 後なので non-null
      })
      socket.on('connect_error', (error) => {
        console.error('CallScreen: WebSocket connection error:', error)
        alert('サーバーとの接続に失敗しました。')
      })
      socket.on('disconnect', (reason) => {
        console.log('CallScreen: WebSocket disconnected:', reason)
        disconnectAll() // PeerJS も切断
        setParticipants([])
        setMyPeerId('')
        myPeerIdRef.current = ''
        setScreenSharingPeerId(null)
        setScreenShareStream(null)
        if (screenVideoRef.current) screenVideoRef.current.srcObject = null
      })
    } else if (socket.connected && !myPeerId) {
      console.log(
        'CallScreen: WebSocket already connected, initializing PeerJS...'
      )
      initializePeer(socket, nameFromStorage)
    }
    // --- ここまで Socket 初期化 ---

    // --- メイン useEffect のクリーンアップ関数 ---
    return () => {
      isMounted = false
      console.log('CallScreen: Cleaning up (useEffect)...')
      if (cleanupWebSocketListeners) cleanupWebSocketListeners()
      stopLocalAudioAnalysis()
      // ★★★ 受信画面共有ストリーム停止 ★★★
      if (screenShareStream) {
        console.log('Cleanup: Stopping received screen share stream.')
        screenShareStream.getTracks().forEach((track) => track.stop())
      }
      if (screenVideoRef.current) {
        screenVideoRef.current.srcObject = null
      }
      // ★ オーディオ要素クリーンアップ
      Object.values(audioRefs.current).forEach((audio) => {
        audio.pause()
        audio.srcObject = null
        audio.remove()
      })
      audioRefs.current = {}
      // disconnectAll はアンマウント時に呼び出す
    }
    // --- ここまでメイン useEffect のクリーンアップ ---

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    roomCode,
    router,
    getDevices,
    myName,
    isMuted,
    // participantVolumes,
    selectedSpeakerId,
    // startLocalAudioAnalysis,
    // stopLocalAudioAnalysis,
    // removePeer,
    // upsertParticipant,
  ])
  // --- ここまでメインの useEffect ---

  // --- アンマウント用 useEffect ---
  useEffect(() => {
    return () => {
      console.log('CallScreen: Component unmounting, disconnecting everything.')
      stopLocalAudioAnalysis()
      // ★★★ 受信画面共有ストリーム停止 ★★★
      if (screenVideoRef.current && screenVideoRef.current.srcObject) {
        const stream = screenVideoRef.current.srcObject as MediaStream
        stream?.getTracks().forEach((track) => track.stop())
        screenVideoRef.current.srcObject = null
      }
      socketRef.current?.disconnect()
      disconnectAll() // PeerJS 切断 & リソース解放
      socketRef.current = null
      console.log('CallScreen: Disconnected socket and PeerJS on unmount.')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // ★ アンマウント時に一度だけ実行

  // --- デフォルト音量設定 useEffect ---
  useEffect(() => {
    const newVolumes = { ...participantVolumes }
    let changed = false
    participants.forEach((p) => {
      if (!p.isSelf && !(p.id in newVolumes)) {
        newVolumes[p.id] = 1.0
        changed = true
      }
    })
    if (changed) {
      setParticipantVolumes(newVolumes)
    }
  }, [participants, participantVolumes])

  // --- JSX レンダリング ---
  return (
    <div className={styles.container}>
      {/* 画面共有表示エリア */}
      <div className={styles.screenShareArea}>
        {screenSharingPeerId && screenShareStream && (
          <video
            ref={screenVideoRef}
            className={styles.screenVideo}
            autoPlay
            playsInline
          />
        )}
        {screenSharingPeerId && !screenShareStream && (
          <div className={styles.loadingScreenShare}>
            {participants.find((p) => p.id === screenSharingPeerId)?.name ||
              '参加者'}
            の画面共有を読み込み中...
          </div>
        )}
        {!screenSharingPeerId && (
          <div className={styles.noScreenShare}>画面共有はされていません</div>
        )}
      </div>

      {/* 共有中インジケーター */}
      {screenSharingPeerId && (
        <div className={styles.sharingIndicator}>
          {screenSharingPeerId === myPeerIdRef.current
            ? 'あなたが画面共有中です'
            : `${participants.find((p) => p.id === screenSharingPeerId)?.name || '参加者'}が画面共有中です`}
        </div>
      )}

      {/* 参加者リスト */}
      <ul className={styles.participantList}>
        {participants.map((p) => {
          if (p.isSelf) {
            return (
              <li
                key={p.id}
                className={`${styles.participantItem} ${styles.selfParticipant} ${p.isSpeaking ? styles.speakingParticipant : ''}`}
              >
                <span className={styles.participantName}>
                  {p.name} (あなた)
                </span>{' '}
                {/* 自分だとわかるように */}
                <span
                  className={`${styles.muteIcon} ${p.isMuted ? styles.muted : ''}`}
                >
                  {' '}
                  {p.isMuted ? '🔇' : '🎤'}{' '}
                </span>
              </li>
            )
          }
          const currentVolume = participantVolumes[p.id] ?? 1.0
          return (
            <li
              key={p.id}
              className={`${styles.participantItem} ${p.isSpeaking ? styles.speakingParticipant : ''}`}
            >
              <span className={styles.participantName}>{p.name}</span>
              <input
                type='range'
                min='0'
                max='1'
                step='0.01'
                value={currentVolume}
                onChange={(e) =>
                  handleVolumeChange(p.id, parseFloat(e.target.value))
                }
                className={styles.volumeSlider}
                title={`音量: ${Math.round(currentVolume * 100)}%`}
              />
              <span
                className={`${styles.muteIcon} ${p.isMuted ? styles.muted : ''}`}
              >
                {' '}
                {p.isMuted ? '🔇' : '🎤'}{' '}
              </span>
            </li>
          )
        })}
      </ul>

      {/* フッター */}
      <CallControlsFooter
        isMuted={isMuted}
        isScreenSharing={isScreenSharing}
        microphones={microphones}
        speakers={speakers}
        selectedMicId={selectedMicId}
        selectedSpeakerId={selectedSpeakerId}
        localStream={localStreamRef.current}
        toggleMic={toggleMic}
        toggleScreenShare={toggleScreenShare}
        handleMicChange={handleMicChange}
        handleSpeakerChange={handleSpeakerChange}
        leaveRoom={leaveRoom}
      />

      {/* オーディオ要素用コンテナ */}
      <div id='audio-container' style={{ display: 'none' }}></div>
    </div>
  )
}
