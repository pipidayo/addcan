// src/app/components/CallScreen/index.tsx
'use client'
import styles from './styles.module.css'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState, useRef, useCallback } from 'react' // useCallback をインポート
import io, { Socket } from 'socket.io-client'
import CallControlsFooter from '../CallControlsFooter' // パスを確認してください
import { usePeerConnection } from '@/app/hooks/usePeerConnection'
import { FiMicOff, FiMonitor } from 'react-icons/fi'

// WebSocket サーバーの URL
const WEBSOCKET_SERVER_URL =
  process.env.NEXT_PUBLIC_WEBSOCKET_SERVER_URL || 'http://localhost:3001'

// --- インターフェース定義 ---
export type Participant = {
  id: string
  name: string
  isMuted: boolean
  isSelf: boolean
  stream?: MediaStream | null // ★ 音声ストリームを保持 (オプショナル)
  isSpeaking?: boolean
}
type UserJoinedPayload = {
  peerId: string
  name: string
}
type UserLeftPayload = {
  peerId: string
}
type ExistingParticipantsPayload = {
  [id: string]: string // { peerId: name, ... }
}
type JoinRoomPayload = {
  roomCode: string | undefined
  peerId: string
  name: string
}

type LocalAudioAnalysisRefs = {
  context: AudioContext | null
  analyser: AnalyserNode | null
  source: MediaStreamAudioSourceNode | null
  animationFrameId: number | null
  dataArray: Uint8Array | null
  isSpeaking: boolean // 最後に検出された状態
}

// --- ここまでtype定義 ---

export default function CallScreen() {
  const { room: roomCodeParam } = useParams()
  const roomCode = Array.isArray(roomCodeParam)
    ? roomCodeParam[0]
    : roomCodeParam
  const router = useRouter()

  // --- State と Ref 定義 ---
  const socketRef = useRef<Socket | null>(null)
  const [socketInstance, setSocketInstance] = useState<Socket | null>(null)
  const [myName] = useState(() => localStorage.getItem('my_name') || '')
  const [participants, setParticipants] = useState<Participant[]>([])
  const audioRefs = useRef<{ [id: string]: HTMLAudioElement }>({})
  const [isMuted, setIsMuted] = useState(false)
  const localStreamRef = useRef<MediaStream | null>(null)
  const myPeerIdRef = useRef<string>('')
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([])
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([])
  const [selectedMicId, setSelectedMicId] = useState<string>('')
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
  const participantVolumesRef = useRef(participantVolumes)
  useEffect(() => {
    participantVolumesRef.current = participantVolumes
  }, [participantVolumes])

  const localSpeakingThreshold = 10

  const [isScreenSharing, setIsScreenSharing] = useState(false)
  const [screenSharingPeerId, setScreenSharingPeerId] = useState<string | null>(
    null
  )
  const screenVideoRef = useRef<HTMLVideoElement>(null)
  const [screenShareStream, setScreenShareStream] =
    useState<MediaStream | null>(null)
  const localScreenPreviewRef = useRef<HTMLVideoElement>(null)
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string>('')
  const selectedSpeakerIdRef = useRef(selectedSpeakerId)
  useEffect(() => {
    selectedSpeakerIdRef.current = selectedSpeakerId
  }, [selectedSpeakerId])
  const [screenVolume, setScreenVolume] = useState(0.7)

  const [pendingScreenStreams, setPendingScreenStreams] = useState<{
    [peerId: string]: MediaStream
  }>({})
  const pendingScreenStreamsRef = useRef(pendingScreenStreams)

  const screenSharingPeerIdRef = useRef(screenSharingPeerId)

  // --- コールバック関数 (useCallback でメモ化) ---

  const handleVolumeChange = useCallback((peerId: string, volume: number) => {
    setParticipantVolumes((prev) => ({ ...prev, [peerId]: volume }))
    const audioElement = audioRefs.current[peerId]
    if (audioElement) {
      audioElement.volume = volume
    }
  }, [])

  const handleReceiveStream = useCallback(
    (stream: MediaStream, peerId: string) => {
      console.log(
        `★★★ [CallScreen] handleReceiveStream (AUDIO ONLY) called! PeerId: ${peerId}`
      )
      if (screenSharingPeerIdRef.current === peerId) {
        console.warn(
          `[CallScreen] Received audio stream from the screen sharing peer ${peerId}. Ignoring.`
        )
        return
      }
      console.log(`CallScreen: Treating stream from ${peerId} as audio.`)
      setParticipants((prev) =>
        prev.map((p) => (p.id === peerId ? { ...p, stream } : p))
      )
    },
    []
  )

  const handleReceiveScreenStream = useCallback(
    (stream: MediaStream, peerId: string) => {
      console.log(
        `★★★ [CallScreen] handleReceiveScreenStream called! PeerId: ${peerId}, Stream ID: ${stream.id}`
      )
      // ★★★ 受信ストリームとトラックの状態をログ出力 ★★★
      const videoTracks = stream.getVideoTracks()
      console.log(
        `[CallScreen handleReceiveScreenStream] Stream active: ${stream.active}`
      )
      if (videoTracks.length > 0) {
        const track = videoTracks[0]
        console.log(
          `[CallScreen handleReceiveScreenStream] Video track info: id=${track.id}, kind=${track.kind}, enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}, label=${track.label}`
        )
      } else {
        console.warn(
          `[CallScreen handleReceiveScreenStream] No video tracks found in the received stream!`
        )
      }
      // ★★★ ここまでログ追加 ★★★

      // 既存の保留ストリームがあれば停止 (新しいストリームで上書きするため)
      setPendingScreenStreams((prev) => {
        const existingPending = prev[peerId]
        if (existingPending && existingPending !== stream) {
          console.log(
            `[CallScreen] Stopping old pending stream for ${peerId} before adding new one.`
          )
          existingPending.getTracks().forEach((track) => track.stop())
        }
        // 新しいストリームを保留リストに追加/更新
        console.log(
          `[CallScreen] Adding/Updating pending screen stream for ${peerId}.`
        )
        return { ...prev, [peerId]: stream }
      })
    },
    [] // 依存配列は空でOK
  )

  const upsertParticipant = useCallback(
    (participantData: Partial<Participant> & { id: string }) => {
      setParticipants((prev) => {
        const existingIndex = prev.findIndex((p) => p.id === participantData.id)
        if (existingIndex !== -1) {
          return prev.map((p, i) =>
            i === existingIndex ? { ...p, ...participantData } : p
          )
        } else {
          const newParticipant: Participant = {
            id: participantData.id,
            name: participantData.name || 'Unknown',
            isMuted: participantData.isMuted ?? false,
            isSelf: participantData.isSelf ?? false,
            stream: participantData.stream ?? null,
            isSpeaking: participantData.isSpeaking ?? false,
          }
          return [...prev, newParticipant]
        }
      })
    },
    []
  )

  const removePeer = useCallback((peerId: string) => {
    setParticipants((prev) => prev.filter((p) => p.id !== peerId))
    if (screenSharingPeerIdRef.current === peerId) {
      console.log(
        `[CallScreen] Screen sharing peer ${peerId} left. Stopping screen share view.`
      )
      setScreenSharingPeerId(null)
      setScreenShareStream(null)
    }
  }, [])

  // ★★★ handleScreenShareStatusChange の定義 (useCallback) ★★★
  const handleScreenShareStatusChange = useCallback(
    (peerId: string, isSharing: boolean) => {
      console.log(
        `★★★ [CallScreen] handleScreenShareStatusChange called! PeerId: ${peerId}, isSharing: ${isSharing}`
      )

      if (isSharing) {
        // 共有開始 -> ID を設定
        console.log(`★★★ [CallScreen] Setting screenSharingPeerId to ${peerId}`)
        setScreenSharingPeerId(peerId)
      } else {
        // 共有停止 -> ID が一致すれば null に設定し、表示中のストリームもクリア
        setScreenSharingPeerId((prevId) => {
          if (prevId === peerId) {
            console.log(
              `[CallScreen] Clearing screenSharingPeerId and stream for ${peerId}.`
            )
            setScreenShareStream(null) // 表示中のストリームをクリア
            return null
          }
          return prevId // 違うピアが停止しても無視
        })
        // 保留リストからも削除 (念のため)
        setPendingScreenStreams((prev) => {
          const newState = { ...prev }
          if (newState[peerId]) {
            console.log(
              `[CallScreen] Removing and stopping pending stream for ${peerId} as sharing stopped.`
            )
            newState[peerId].getTracks().forEach((track) => track.stop())
            delete newState[peerId]
          }
          return newState
        })
      }
    },
    [] // 依存配列は空でOK
  )

  // --- コールバック参照 Ref ---
  const callbacksRef = useRef({
    handleReceiveStream,
    handleReceiveScreenStream,
    upsertParticipant,
    removePeer,
    handleScreenShareStatusChange, // 追加
  })

  // --- Ref の更新 Effect ---
  useEffect(() => {
    callbacksRef.current = {
      handleReceiveStream,
      handleReceiveScreenStream,
      upsertParticipant,
      removePeer,
      handleScreenShareStatusChange, // 追加
    }
  }, [
    handleReceiveStream,
    handleReceiveScreenStream,
    upsertParticipant,
    removePeer,
    handleScreenShareStatusChange, // 追加
  ])

  // --- 他のコールバック関数 (useCallback) ---

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
            !analysis.context ||
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

  const handleSpeakerChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const newSpeakerId = event.target.value
      console.log('Selected Speaker ID:', newSpeakerId)
      setSelectedSpeakerId(newSpeakerId)
      Object.values(audioRefs.current).forEach(async (audioElement) => {
        if (audioElement && typeof audioElement.setSinkId === 'function') {
          try {
            await audioElement.setSinkId(newSpeakerId)
          } catch (err) {
            console.error('Error setting sinkId:', err)
          }
        }
      })
    },
    []
  )

  const leaveRoom = useCallback(() => {
    console.log('CallScreen: Leaving room...')
    router.push('/')
  }, [router])

  const handleScreenVolumeChange = useCallback((volume: number) => {
    setScreenVolume(volume)
    if (screenVideoRef.current) {
      screenVideoRef.current.volume = volume
    }
  }, [])

  // --- usePeerConnection フックの呼び出し ---
  const {
    myPeerId: myPeerIdFromHook,
    localStream,
    screenStream: localScreenStreamFromHook,
    callPeer: callPeerHook,
    sendMuteStatus: sendMuteStatusHook,
    switchMicrophone: switchMicrophoneHook,
    startScreenShare: startScreenShareHook,
    stopScreenShare: stopScreenShareHook,
  } = usePeerConnection({
    roomCode,
    myName,
    socket: socketInstance,
    onRemoteStream: (...args) =>
      callbacksRef.current.handleReceiveStream(...args),
    onRemoteScreenStreamUpdate: (...args) =>
      callbacksRef.current.handleReceiveScreenStream(...args),
    onParticipantUpdate: (...args) =>
      callbacksRef.current.upsertParticipant(...args),
    onParticipantRemove: (...args) => callbacksRef.current.removePeer(...args),
    // ★★★ onScreenShareStatusChange は渡さない ★★★
  })

  // --- フックの結果を使用するコールバック関数 ---

  const handleMicChange = useCallback(
    async (event: React.ChangeEvent<HTMLSelectElement>) => {
      const newMicId = event.target.value
      const currentMicId = selectedMicId
      console.log('Selected Microphone ID:', newMicId)
      setSelectedMicId(newMicId)
      try {
        stopLocalAudioAnalysis()
        await switchMicrophoneHook(newMicId)
        console.log('Microphone switched successfully via hook')
      } catch (error) {
        console.error('Failed to switch microphone:', error)
        alert(
          `マイクの切り替えに失敗しました: ${error instanceof Error ? error.message : String(error)}`
        )
        setSelectedMicId(currentMicId)
      }
    },
    [selectedMicId, stopLocalAudioAnalysis, switchMicrophoneHook]
  )

  const toggleMic = useCallback(() => {
    if (!localStream) return
    const audioTrack = localStream.getAudioTracks()[0]
    if (audioTrack) {
      const newEnabledState = !audioTrack.enabled
      audioTrack.enabled = newEnabledState
      const newMuteState = !newEnabledState
      setIsMuted(newMuteState)
      setParticipants((prev) =>
        prev.map((p) => (p.isSelf ? { ...p, isMuted: newMuteState } : p))
      )
      sendMuteStatusHook(newMuteState)
      console.log('Mute status sent via hook:', newMuteState)
    }
  }, [localStream, sendMuteStatusHook])

  const toggleScreenShare = useCallback(async () => {
    if (isScreenSharing) {
      try {
        await stopScreenShareHook()
        setIsScreenSharing(false)
        console.log('CallScreen: Screen sharing stopped via hook.')

        if (socketInstance?.connected) {
          console.log(
            '[CallScreen toggleScreenShare] Emitting screen-share-status: false'
          )
          socketInstance.emit('screen-share-status', { isSharing: false })
        }
      } catch (error) {
        console.error('CallScreen: Failed to stop screen share:', error)
        alert(
          `画面共有の停止に失敗しました: ${error instanceof Error ? error.message : String(error)}`
        )
        setIsScreenSharing(false)
        if (socketInstance?.connected) {
          console.log(
            '[CallScreen toggleScreenShare] Emitting screen-share-status: false (on error)'
          )
          socketInstance.emit('screen-share-status', { isSharing: false })
        }
      }
    } else {
      // --- 画面共有開始処理 ---
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
        await startScreenShareHook()
        setIsScreenSharing(true)
        console.log('CallScreen: Screen sharing started via hook.')

        if (socketInstance?.connected) {
          console.log(
            '[CallScreen toggleScreenShare] Emitting screen-share-status: true'
          )
          socketInstance.emit('screen-share-status', { isSharing: true })
        }
      } catch (error) {
        console.error('CallScreen: Failed to start screen share:', error)
        if (error instanceof Error && error.name !== 'NotAllowedError') {
          alert(`画面共有の開始に失敗しました: ${error.message}`)
        }
        setIsScreenSharing(false)
      }
    }
  }, [
    isScreenSharing,
    screenSharingPeerId,
    participants,
    startScreenShareHook,
    stopScreenShareHook,
    socketInstance,
  ])

  // --- useEffect フック ---

  useEffect(() => {
    if (myPeerIdFromHook) {
      myPeerIdRef.current = myPeerIdFromHook
      upsertParticipant({
        id: myPeerIdFromHook,
        name: myName,
        isMuted: isMuted,
        isSelf: true,
      })
    }
  }, [myPeerIdFromHook, myName, isMuted, upsertParticipant])

  useEffect(() => {
    localStreamRef.current = localStream
    if (localStream) {
      startLocalAudioAnalysis(localStream)
    } else {
      stopLocalAudioAnalysis()
    }
    return () => {
      stopLocalAudioAnalysis()
    }
  }, [localStream, startLocalAudioAnalysis, stopLocalAudioAnalysis])

  useEffect(() => {
    console.log('[CallScreen WebSocket Connection useEffect] Initializing...')
    if (!roomCode) {
      console.error('Room code is missing.')
      router.push('/')
      return
    }
    const isMounted = { current: true }
    if (socketRef.current) {
      if (socketRef.current.connected && !socketInstance) {
        setSocketInstance(socketRef.current)
      }
      return
    }
    console.log('CallScreen: Initializing WebSocket connection...')
    const socket = io(WEBSOCKET_SERVER_URL)
    socketRef.current = socket
    socket.on('connect', () => {
      console.log('★★★ CallScreen: WebSocket connected! Socket ID:', socket.id)
      if (isMounted.current) {
        setSocketInstance(socket)
      }
    })
    socket.on('connect_error', (error) => {
      console.error('CallScreen: WebSocket connection error:', error)
      alert('サーバーとの接続に失敗しました。')
      socketRef.current = null
      if (isMounted.current) {
        setSocketInstance(null)
      }
    })
    socket.on('disconnect', (reason) => {
      console.log('CallScreen: WebSocket disconnected:', reason)
      if (isMounted.current) {
        setSocketInstance(null)
      }
      setParticipants([])
      myPeerIdRef.current = ''
      setScreenSharingPeerId(null)
      setScreenShareStream(null)
      if (screenVideoRef.current) screenVideoRef.current.srcObject = null
      socketRef.current = null
    })
    return () => {
      isMounted.current = false
      console.log('CallScreen: Cleaning up WebSocket Connection useEffect...')
    }
  }, [roomCode, router, socketInstance])

  // --- WebSocket 関連 useEffect (リスナー設定) ---
  useEffect(() => {
    if (!socketInstance) return
    console.log('[CallScreen WebSocket Listeners useEffect] Setting up...')

    const handleUserJoined = (payload: UserJoinedPayload) => {
      const { peerId, name } = payload
      if (peerId === myPeerIdRef.current) return
      console.log(`CallScreen: User joined: ${name} (${peerId})`)
      callbacksRef.current.upsertParticipant({
        id: peerId,
        name,
        isMuted: false,
        isSelf: false,
      }) // Ref経由で呼び出し
      callPeerHook(peerId).catch((error) =>
        console.error(`CallScreen: Failed to call new peer ${peerId}:`, error)
      )
    }
    const handleUserLeft = (payload: UserLeftPayload) => {
      console.log(`CallScreen: User left: ${payload.peerId}`)
      // removePeer は PeerJS の onPeerDisconnect で呼ばれるのでここでは不要
    }
    const handleExistingParticipants = (
      payload: ExistingParticipantsPayload
    ) => {
      console.log('CallScreen: Received existing participants:', payload)
      const currentPeerId = myPeerIdRef.current
      Object.entries(payload)
        .filter(([id]) => id !== currentPeerId)
        .forEach(([id, name]) => {
          callbacksRef.current.upsertParticipant({
            id,
            name,
            isMuted: false,
            isSelf: false,
          }) // Ref経由で呼び出し
          callPeerHook(id).catch((error) =>
            console.error(
              `CallScreen: Failed to call existing peer ${id}:`,
              error
            )
          )
        })
    }
    // ★★★ 画面共有ステータス変更のリスナーを追加 ★★★
    const handleScreenShareStatus = (payload: {
      peerId: string
      isSharing: boolean
    }) => {
      console.log(
        `★★★ [CallScreen] Received 'screen-share-status' event via WebSocket:`,
        payload
      )
      callbacksRef.current.handleScreenShareStatusChange(
        payload.peerId,
        payload.isSharing
      ) // Ref経由で呼び出し
    }

    socketInstance.on('user-joined', handleUserJoined)
    socketInstance.on('user-left', handleUserLeft)
    socketInstance.on('existing-participants', handleExistingParticipants)
    // ★★★ イベント名はサーバー側の実装に合わせてください ★★★
    socketInstance.on('screen-share-status', handleScreenShareStatus)

    return () => {
      console.log('[CallScreen WebSocket Listeners useEffect] Cleaning up...')
      socketInstance.off('user-joined', handleUserJoined)
      socketInstance.off('user-left', handleUserLeft)
      socketInstance.off('existing-participants', handleExistingParticipants)
      // ★★★ リスナー解除 ★★★
      socketInstance.off('screen-share-status', handleScreenShareStatus)
    }
    // ★★★ 依存配列を修正 ★★★
  }, [socketInstance, callPeerHook]) // upsertParticipant は Ref 経由なので不要

  // --- WebSocket 関連 useEffect (join-room 送信) ---
  useEffect(() => {
    if (socketInstance && myPeerIdFromHook && myName) {
      console.log(
        `CallScreen: Emitting join-room with peerId: ${myPeerIdFromHook}`
      )
      const joinPayload: JoinRoomPayload = {
        roomCode,
        peerId: myPeerIdFromHook,
        name: myName,
      }
      socketInstance.emit('join-room', joinPayload)
    }
  }, [socketInstance, myPeerIdFromHook, myName, roomCode])

  // --- アンマウント用 useEffect ---

  useEffect(() => {
    // ★ エフェクト実行時の ref の値をコピー
    const screenVideoElement = screenVideoRef.current
    const socketInstanceToDisconnect = socketRef.current // socketRef も同様

    return () => {
      console.log('CallScreen: Component unmounting, disconnecting everything.')

      // ★ コピーした変数をクリーンアップ関数で使用
      if (screenVideoElement && screenVideoElement.srcObject) {
        console.log('CallScreen: Stopping screen share stream on unmount.')
        const stream = screenVideoElement.srcObject as MediaStream
        stream?.getTracks().forEach((track) => track.stop())
        screenVideoElement.srcObject = null
      }

      // ★ コピーした socket インスタンスを切断
      if (socketInstanceToDisconnect) {
        console.log('CallScreen: Disconnecting socket on unmount.')
        socketInstanceToDisconnect.disconnect()
        socketRef.current = null // Ref もクリア (任意だが推奨)
      }

      // PeerJS の切断は usePeerConnection のクリーンアップで行われる
      console.log('CallScreen: Cleanup on unmount finished.')
    }
  }, []) // 依存配列は空のまま

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

  // --- デバイス取得 useEffect ---
  useEffect(() => {
    getDevices()
  }, [getDevices])

  // (画面共有ストリームのアクティベート処理)
  useEffect(() => {
    console.log(
      `[CallScreen Activate Effect] Running. Sharer: ${screenSharingPeerId}, Pending keys: ${Object.keys(pendingScreenStreams)}`
    )

    if (screenSharingPeerId) {
      // 共有者がいる場合
      const pendingStream = pendingScreenStreams[screenSharingPeerId]
      if (pendingStream) {
        // 保留中のストリームが見つかった場合
        if (screenShareStream !== pendingStream) {
          console.log(
            `[CallScreen Activate Effect] Activating pending stream for ${screenSharingPeerId}.`
          )

          // ★★★ アクティベートするストリームとトラックの状態をログ出力 ★★★
          const videoTracks = pendingStream.getVideoTracks()
          console.log(
            `[CallScreen Activate Effect] Activating Stream active: ${pendingStream.active}`
          )
          if (videoTracks.length > 0) {
            const track = videoTracks[0]
            console.log(
              `[CallScreen Activate Effect] Activating Video track info: id=${track.id}, kind=${track.kind}, enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}, label=${track.label}`
            )
          } else {
            console.warn(
              `[CallScreen Activate Effect] No video tracks found in the stream being activated!`
            )
          }

          setScreenShareStream(pendingStream) // state を更新して表示
          // 保留リストから削除
          setPendingScreenStreams((prev) => {
            const newState = { ...prev }
            delete newState[screenSharingPeerId]
            console.log(
              `[CallScreen Activate Effect] Removed activated stream from pending. Remaining keys: ${Object.keys(newState)}`
            )
            return newState
          })
        } else {
          console.log(
            `[CallScreen Activate Effect] Stream for ${screenSharingPeerId} is already active.`
          )
        }
      } else {
        // 共有者はいるが、保留中のストリームがない場合 (まだ届いていない or 既にアクティブ化済み)
        // 既にアクティブなストリームがなければ null にして「読み込み中」表示を維持
        if (!screenShareStream) {
          console.log(
            `[CallScreen Activate Effect] Sharer is ${screenSharingPeerId}, but no pending stream found and no active stream. Setting stream to null (waiting).`
          )
          // setScreenShareStream(null); // 既に null のはずなので不要かも
        } else {
          console.log(
            `[CallScreen Activate Effect] Sharer is ${screenSharingPeerId}, no pending stream, but a stream is already active.`
          )
        }
      }
    } else {
      // 共有者がいない場合
      if (screenShareStream) {
        console.log(
          '[CallScreen Activate Effect] No sharer, clearing active screen stream.'
        )
        setScreenShareStream(null) // 表示中のストリームをクリア
      }
      // (任意) 共有者がいないのに保留リストに残っているストリームがあればクリーンアップ
      if (Object.keys(pendingScreenStreams).length > 0) {
        console.warn(
          '[CallScreen Activate Effect] No sharer, but pending streams exist. Cleaning up pending streams.'
        )
        setPendingScreenStreams((prev) => {
          Object.values(prev).forEach((stream) =>
            stream.getTracks().forEach((track) => track.stop())
          )
          return {} // 保留リストを空にする
        })
      }
    }
    // ★★★ 依存配列に screenSharingPeerId と pendingScreenStreams を指定 ★★★
  }, [screenSharingPeerId, pendingScreenStreams, screenShareStream]) // screenShareStream も比較のために追加

  // --- 受信画面共有ストリーム設定 useEffect ---
  useEffect(() => {
    if (screenVideoRef.current && screenShareStream) {
      console.log('CallScreen: Setting screen share stream to video element.')
      screenVideoRef.current.srcObject = screenShareStream
      screenVideoRef.current.volume = screenVolume
      screenVideoRef.current.muted = false
      screenVideoRef.current
        .play()
        .catch((e) => console.error('Screen share video play failed:', e))
    } else {
      // ストリームが null になった場合 (共有停止時など) は srcObject もクリア
      if (screenVideoRef.current) {
        screenVideoRef.current.srcObject = null
      }
    }
  }, [screenShareStream, screenVolume]) // screenVolume も依存配列に追加
  // --- ローカル画面共有プレビュー useEffect ---
  useEffect(() => {
    if (
      localScreenPreviewRef.current &&
      isScreenSharing &&
      localScreenStreamFromHook
    ) {
      console.log('CallScreen: Setting local screen stream to preview element.')
      localScreenPreviewRef.current.srcObject = localScreenStreamFromHook
      localScreenPreviewRef.current.muted = true
      localScreenPreviewRef.current
        .play()
        .catch((e) => console.error('Local screen preview play failed:', e))
    } else {
      if (localScreenPreviewRef.current) {
        localScreenPreviewRef.current.srcObject = null
      }
    }
  }, [isScreenSharing, localScreenStreamFromHook])

  // --- JSX レンダリング ---
  return (
    <div className={styles.container}>
      {/* 参加者リスト */}
      <ul className={styles.participantList}>
        {participants.map((p) => {
          // --- 自分自身の表示 ---
          if (p.isSelf) {
            return (
              <li
                key={p.id}
                className={`${styles.participantItem} ${styles.selfParticipant} ${p.isSpeaking ? styles.speakingParticipant : ''} ${p.isMuted ? styles.mutedEffect : ''}`}
              >
                <div className={styles.participantInfo}>
                  <span className={styles.participantName}>{p.name}</span>
                  {/* ★ 自分が画面共有中のアイコン (ローカル状態 or グローバル状態) */}
                  {/* isScreenSharing は自分が共有ボタンを押した状態 */}
                  {(isScreenSharing || p.id === screenSharingPeerId) && (
                    <FiMonitor
                      className={styles.screenShareIndicatorIcon}
                      title='画面共有中'
                    />
                  )}
                </div>
                <FiMicOff className={styles.muteIndicatorIcon} />
              </li>
            )
          }
          // --- 他の参加者の表示 ---
          const currentVolume = participantVolumes[p.id] ?? 1.0
          return (
            <li
              key={p.id}
              className={`${styles.participantItem} ${p.isSpeaking ? styles.speakingParticipant : ''} ${p.isMuted ? styles.mutedEffect : ''}`}
            >
              <div className={styles.participantInfo}>
                <span className={styles.participantName}>{p.name}</span>
                {p.id === screenSharingPeerId && (
                  <FiMonitor
                    className={styles.screenShareIndicatorIcon}
                    title='画面共有中'
                  />
                )}
              </div>
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
              <FiMicOff className={styles.muteIndicatorIcon} />
              {/* ★ Audio 要素を追加 */}
              {p.stream && (
                <audio
                  ref={(el) => {
                    if (el) {
                      audioRefs.current[p.id] = el

                      //     既に設定されている場合やストリームが同じ場合は再設定しない
                      const newSrcObject = p.stream ?? null
                      if (el.srcObject !== newSrcObject) {
                        console.log(
                          `[CallScreen] Setting/Clearing srcObject for audio element ${p.id}`
                        )
                        el.srcObject = newSrcObject // ここで null が設定される可能性がある
                      }
                    } else {
                      // 要素がアンマウントされたら Ref から削除
                      delete audioRefs.current[p.id]
                    }
                  }}
                  autoPlay
                  playsInline
                  muted={false} // 音声はミュートしない
                  // srcObject={p.stream} // ← JSX プロパティからは削除
                  onLoadedMetadata={(e) => {
                    const target = e.target as HTMLAudioElement
                    // スピーカー設定
                    if (typeof target.setSinkId === 'function') {
                      target
                        .setSinkId(selectedSpeakerIdRef.current)
                        .catch((err) =>
                          console.error(
                            'Failed to set sinkId on audio element:',
                            err
                          )
                        )
                    }
                    // 音量設定
                    target.volume = participantVolumesRef.current[p.id] ?? 1.0
                  }}
                />
              )}
            </li>
          )
        })}
      </ul>

      {/* 画面共有表示エリア */}
      <div className={styles.screenShareArea}>
        {(() => {
          // 優先順位1: 自分が共有中ならローカルプレビューを表示
          if (isScreenSharing && localScreenStreamFromHook) {
            return (
              <video
                ref={localScreenPreviewRef}
                className={styles.localScreenPreview}
                autoPlay
                playsInline
                muted
              />
            )
          }
          // 優先順位2: 他の誰かが共有中なら受信ビデオを表示
          else if (
            screenSharingPeerId &&
            screenSharingPeerId !== myPeerIdRef.current &&
            screenShareStream
          ) {
            return (
              <video
                ref={screenVideoRef}
                className={styles.screenVideo}
                autoPlay
                playsInline
              />
            )
          }
          // ★★★ 優先順位3: 共有者が確定していて、ストリーム待ちの場合に「読み込み中」を表示 ★★★
          else if (
            screenSharingPeerId &&
            screenSharingPeerId !== myPeerIdRef.current &&
            !screenShareStream
          ) {
            return (
              <div className={styles.loadingScreenShare}>
                画面を読み込み中...
              </div>
            )
          }
          // それ以外: 誰も共有していない
          else {
            return (
              <div className={styles.noScreenShare}>
                画面共有はされていません
              </div>
            )
          }
        })()}
      </div>

      {/* フッター */}
      <CallControlsFooter
        isMuted={isMuted}
        isScreenSharing={isScreenSharing}
        microphones={microphones}
        speakers={speakers}
        selectedMicId={selectedMicId}
        selectedSpeakerId={selectedSpeakerId}
        localStream={localStream}
        toggleMic={toggleMic}
        toggleScreenShare={toggleScreenShare}
        handleMicChange={handleMicChange}
        handleSpeakerChange={handleSpeakerChange}
        leaveRoom={leaveRoom}
        screenSharingPeerId={screenSharingPeerId}
        myPeerId={myPeerIdRef.current}
        participants={participants}
        roomCode={roomCode}
        screenVolume={screenVolume}
        handleScreenVolumeChange={handleScreenVolumeChange}
      />

      {/* オーディオ要素用コンテナ */}
      <div id='audio-container' style={{ display: 'none' }}></div>
    </div>
  )
}
