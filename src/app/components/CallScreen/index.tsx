// src/app/components/CallScreen/index.tsx
'use client'
import styles from './styles.module.css'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import io, { Socket } from 'socket.io-client'
import CallControlsFooter from '../CallControlsFooter'
import { usePeerConnection } from '@/app/hooks/usePeerConnection'
import { FiMicOff, FiMonitor } from 'react-icons/fi'
import { toast } from 'react-toastify'
import ParticipantList from '../ParticipantList'

// WebSocket サーバーの URL
const WEBSOCKET_SERVER_URL =
  process.env.NEXT_PUBLIC_WEBSOCKET_SERVER_URL || 'http://localhost:3001'

// --- インターフェース定義 ---
export type Participant = {
  id: string
  name: string
  isMuted: boolean
  isSelf: boolean
  stream?: MediaStream | null
  isSpeaking?: boolean
}
type ServerParticipants = {
  [peerId: string]: string
}
type RoomStatePayload = {
  participants: ServerParticipants
  currentSharerId: string | null
}
type ScreenShareStatusPayload = {
  peerId: string
  isSharing: boolean
  sharerPeerId: string | null
}
type UserJoinedPayload = {
  peerId: string
  name: string
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
  isSpeaking: boolean
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
  const [isMuted, setIsMuted] = useState(false)
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

  const [screenVolume, setScreenVolume] = useState(0.7)

  const [pendingScreenStreams, setPendingScreenStreams] = useState<{
    [peerId: string]: MediaStream
  }>({})

  // ★★★ コールバック関数を保持するための Ref を作成 ★★★
  const onRemoteStreamRef =
    useRef<(stream: MediaStream, peerId: string) => void>(undefined) // <--- undefined を追加
  const onRemoteScreenStreamUpdateRef =
    useRef<(stream: MediaStream, peerId: string) => void>(undefined) // <--- undefined を追加
  const onParticipantUpdateRef =
    useRef<(participantData: Partial<Participant> & { id: string }) => void>(
      undefined
    ) // <--- undefined を追加
  const onParticipantRemoveRef = useRef<(peerId: string) => void>(undefined) // <--- undefined を追加

  const callPeerHookRef = useRef<(peerId: string) => Promise<void>>(undefined)
  // ★★★ usePeerConnection の呼び出しをここに移動 ★★★
  const {
    myPeerId: myPeerIdFromHook,
    localStream,
    screenStream: localScreenStreamFromHook,
    callPeer: callPeerHookFromHook,
    sendMuteStatus: sendMuteStatusHook,
    switchMicrophone: switchMicrophoneHook,
    startScreenShare: startScreenShareHook,
    stopScreenShare: stopScreenShareHook,
  } = usePeerConnection({
    roomCode,
    myName,
    socket: socketInstance,
    // ★ Ref を介してコールバック関数を渡す
    onRemoteStream: (...args) => onRemoteStreamRef.current?.(...args),
    onRemoteScreenStreamUpdate: (...args) =>
      onRemoteScreenStreamUpdateRef.current?.(...args),
    onParticipantUpdate: (...args) => onParticipantUpdateRef.current?.(...args),
    onParticipantRemove: (...args) => onParticipantRemoveRef.current?.(...args),
  })
  // ★★★ ここまで usePeerConnection 移動 ★★★

  // --- コールバック関数 (useCallback でメモ化) ---
  // (useCallback の定義は usePeerConnection の後でOK)

  const handleVolumeChange = useCallback((peerId: string, volume: number) => {
    setParticipantVolumes((prev) => ({ ...prev, [peerId]: volume }))
  }, [])

  const handleReceiveStream = useCallback(
    (stream: MediaStream, peerId: string) => {
      console.log(
        `★★★ [CallScreen] handleReceiveStream (AUDIO ONLY) called! PeerId: ${peerId}`
      )
      if (screenSharingPeerId === peerId) {
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
    [screenSharingPeerId]
  )

  const handleReceiveScreenStream = useCallback(
    (stream: MediaStream, peerId: string) => {
      console.log(
        `★★★ [CallScreen] handleReceiveScreenStream called! PeerId: ${peerId}, Stream ID: ${stream.id}`
      )
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

      if (screenSharingPeerId === peerId) {
        console.log(
          `[CallScreen] Setting received screen stream from ${peerId}`
        )
        setScreenShareStream(stream)
      } else {
        console.warn(
          `[CallScreen] Received screen stream from ${peerId}, but current sharer is ${screenSharingPeerId}. Ignoring or pending.`
        )
        // setPendingScreenStreams((prev) => ({ ...prev, [peerId]: stream }));
      }
    },
    [screenSharingPeerId]
  )

  // ★ upsertParticipant は myPeerIdFromHook を使うので、usePeerConnection の後にある
  const upsertParticipant = useCallback(
    (participantData: Partial<Participant> & { id: string }) => {
      setParticipants((prev) => {
        const existingIndex = prev.findIndex((p) => p.id === participantData.id)
        // ↓ isSelf の判定を myPeerIdFromHook を使って行う
        const isSelf =
          participantData.isSelf ?? participantData.id === myPeerIdFromHook

        if (existingIndex !== -1) {
          // 既存参加者の情報を更新
          console.log(
            `[CallScreen upsertParticipant] Updating participant: ${participantData.id}`
          )
          return prev.map((p, i) =>
            i === existingIndex
              ? {
                  ...p,
                  ...participantData,
                  isSelf: isSelf, // isSelf も更新
                }
              : p
          )
        } else {
          // 新規参加者を追加
          // ★ 念のため、自分自身を再度追加しようとしていないかチェック
          if (isSelf && prev.some((p) => p.isSelf)) {
            console.warn(
              `[CallScreen upsertParticipant] Trying to add self again? ID: ${participantData.id}`
            )
            // 既に自分がリストにいる場合は情報を更新するだけにする
            return prev.map((p) =>
              p.isSelf ? { ...p, ...participantData, isSelf: true } : p
            )
          }

          console.log(
            `[CallScreen upsertParticipant] Adding new participant: ${participantData.id}`
          )
          const newParticipant: Participant = {
            id: participantData.id,
            name: participantData.name || 'Unknown',
            isMuted: participantData.isMuted ?? false,
            isSelf: isSelf, // isSelf を設定
            stream: participantData.stream ?? null,
            isSpeaking: participantData.isSpeaking ?? false,
          }
          return [...prev, newParticipant]
        }
      })
    },
    [myPeerIdFromHook] // ★ myPeerIdFromHook が変わったら再生成
  )

  const removePeer = useCallback(
    (peerId: string) => {
      setParticipants((prev) => prev.filter((p) => p.id !== peerId))
      if (screenSharingPeerId === peerId) {
        console.log(
          `[CallScreen] Screen sharing peer ${peerId} left. Stopping screen share view.`
        )
        setScreenSharingPeerId(null)
        setScreenShareStream(null)
      }
    },
    [screenSharingPeerId]
  )

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

      if (audioInputDevices.length > 0) {
        setSelectedMicId((prevId) => {
          if (
            !prevId ||
            !audioInputDevices.some((d) => d.deviceId === prevId)
          ) {
            return audioInputDevices[0].deviceId
          }
          return prevId
        })
      }

      const defaultSpeaker = audioOutputDevices.find(
        (d) => d.deviceId === 'default'
      )
      setSelectedSpeakerId((prevId) => {
        if (defaultSpeaker) {
          return defaultSpeaker.deviceId
        } else if (audioOutputDevices.length > 0) {
          if (
            !prevId ||
            !audioOutputDevices.some((d) => d.deviceId === prevId)
          ) {
            return audioOutputDevices[0].deviceId
          }
        }
        return prevId
      })

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
    // myPeerIdRef ではなく myPeerIdFromHook を使うべきだが、
    // ここで setParticipants を呼ぶとループする可能性があるので注意
    // if (myPeerIdFromHook) {
    //   setParticipants((prev) =>
    //     prev.map((p) =>
    //       p.id === myPeerIdFromHook ? { ...p, isSpeaking: false } : p
    //     )
    //   );
    // }
  }, []) // myPeerIdFromHook を依存配列に入れるとループする可能性

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
            // ★ ここも myPeerIdFromHook を使うべきだがループに注意
            if (myPeerIdFromHook) {
              // isSpeaking 状態だけを更新する (upsertParticipant ではない)
              setParticipants((prev) =>
                prev.map((p) =>
                  p.id === myPeerIdFromHook ? { ...p, isSpeaking } : p
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
    [
      localSpeakingThreshold,
      stopLocalAudioAnalysis,
      myPeerIdFromHook, // ★ 依存配列に追加
    ]
  )

  const handleSpeakerChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const newSpeakerId = event.target.value
      console.log('Selected Speaker ID:', newSpeakerId)
      setSelectedSpeakerId(newSpeakerId)
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

  // --- フックの結果を使用するコールバック関数 (usePeerConnection の後) ---

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
      // ★ upsertParticipant を使って自分のミュート状態を更新
      if (myPeerIdFromHook) {
        upsertParticipant({ id: myPeerIdFromHook, isMuted: newMuteState })
      }
      sendMuteStatusHook(newMuteState)
      console.log('Mute status sent via hook:', newMuteState)
    }
  }, [localStream, sendMuteStatusHook, myPeerIdFromHook, upsertParticipant]) // ★ 依存配列更新

  const toggleScreenShare = useCallback(async () => {
    const currentlySharing =
      screenSharingPeerId === myPeerIdFromHook && myPeerIdFromHook !== ''

    if (currentlySharing) {
      try {
        await stopScreenShareHook()
        console.log('CallScreen: Screen sharing stopped via hook.')
      } catch (error) {
        console.error('CallScreen: Failed to stop screen share:', error)
        alert(
          `画面共有の停止に失敗しました: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    } else {
      if (screenSharingPeerId !== null) {
        toast('現在他のユーザーが画面共有中です。')
        return
      }
      try {
        await startScreenShareHook()
        console.log('CallScreen: Screen sharing started via hook.')
      } catch (error) {
        console.error('CallScreen: Failed to start screen share:', error)
        if (error instanceof Error && error.name !== 'NotAllowedError') {
          alert(`画面共有の開始に失敗しました: ${error.message}`)
        }
      }
    }
  }, [
    screenSharingPeerId,
    myPeerIdFromHook,
    startScreenShareHook,
    stopScreenShareHook,
  ])

  // --- useEffect フック (usePeerConnection の後) ---

  // ★ Ref を最新の関数で更新する Effect
  useEffect(() => {
    onRemoteStreamRef.current = handleReceiveStream
  }, [handleReceiveStream])

  useEffect(() => {
    onRemoteScreenStreamUpdateRef.current = handleReceiveScreenStream
  }, [handleReceiveScreenStream])

  useEffect(() => {
    onParticipantUpdateRef.current = upsertParticipant
  }, [upsertParticipant])

  useEffect(() => {
    onParticipantRemoveRef.current = removePeer
  }, [removePeer])

  useEffect(() => {
    callPeerHookRef.current = callPeerHookFromHook
  }, [callPeerHookFromHook])
  // ★★★ ここまで Ref 更新 Effect ★★★

  useEffect(() => {
    if (myPeerIdFromHook) {
      // ★ 自分の共有状態のみここで更新する
      setIsScreenSharing(screenSharingPeerId === myPeerIdFromHook)
    }
    // upsertParticipant は依存配列から削除 (handleRoomState で呼ばれるため)
  }, [myPeerIdFromHook, screenSharingPeerId])

  useEffect(() => {
    if (localStream) {
      startLocalAudioAnalysis(localStream)
    } else {
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
      // myPeerIdRef.current = ''; // 不要かも
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

  useEffect(() => {
    if (!socketInstance) return
    console.log('[CallScreen WebSocket Listeners useEffect] Setting up...')

    const handleRoomState = (payload: RoomStatePayload) => {
      console.log(
        '★★★ [CallScreen] Received room-state event payload:',
        payload
      )
      const { participants: serverParticipants, currentSharerId } = payload
      const currentMyPeerId = myPeerIdFromHook

      for (const peerId in serverParticipants) {
        console.log(
          `[CallScreen handleRoomState] Upserting participant from room state: ${peerId}`
        )
        onParticipantUpdateRef.current?.({
          id: peerId,
          name: serverParticipants[peerId],
          isMuted: false,
          isSelf: peerId === currentMyPeerId,
          stream: null,
          isSpeaking: false,
        })
      }
      setScreenSharingPeerId(currentSharerId)
    }

    const handleUserJoined = (payload: UserJoinedPayload) => {
      const { peerId, name } = payload
      const currentMyPeerId = myPeerIdFromHook // 最新の myPeerIdFromHook を参照
      if (peerId === currentMyPeerId) return
      console.log(
        `★★★ [CallScreen] Received user-joined event via WebSocket: ${name} (${peerId})`
      )
      // ★ Ref 経由で upsertParticipant を呼ぶ
      onParticipantUpdateRef.current?.({
        id: peerId,
        name,
        isMuted: false,
        isSelf: false,
      })
      // ★ Ref 経由で callPeerHook を呼ぶ
      callPeerHookRef
        .current?.(peerId)
        .catch((error) =>
          console.error(
            `[CallScreen user-joined] Failed to call new peer ${peerId}:`,
            error
          )
        )
    }
    // ↑↑↑ handleUserJoined はここまで ↑↑↑

    // ↓↓↓ handleUserLeft はここに1つだけ定義 ↓↓↓
    const handleUserLeft = (peerId: string) => {
      console.log(
        `★★★ [CallScreen] Received user-left event via WebSocket: ${peerId}`
      )
      // removePeer は PeerJS のイベントで処理される想定なのでここでは何もしない
    }
    // ↑↑↑ handleUserLeft はここまで ↑↑↑

    // ↓↓↓ handleScreenShareStatus はここに1つだけ定義 ↓↓↓
    const handleScreenShareStatus = (payload: ScreenShareStatusPayload) => {
      console.log(
        '★★★ [CallScreen] Received screen-share-status event via WebSocket:',
        payload
      )
      const { peerId, isSharing, sharerPeerId: currentSharerId } = payload
      const currentMyPeerId = myPeerIdFromHook // 最新の myPeerIdFromHook を参照

      setScreenSharingPeerId(currentSharerId)
      setIsScreenSharing(currentSharerId === currentMyPeerId) // 自分の共有状態も更新

      // screenShareStream は state を直接参照する必要がある
      // ↓ screenShareStream と screenSharingPeerId を直接参照するように修正
      if (
        !isSharing &&
        screenShareStream &&
        currentSharerId !== peerId &&
        screenSharingPeerId === peerId
      ) {
        console.log(
          `[CallScreen screen-share-status] Clearing remote screen stream because ${peerId} stopped sharing.`
        )
        setScreenShareStream(null)
      }
    }

    socketInstance.on('room-state', handleRoomState)
    socketInstance.on('user-joined', handleUserJoined)
    socketInstance.on('user-left', handleUserLeft)
    socketInstance.on('screen-share-status', handleScreenShareStatus)

    return () => {
      console.log('[CallScreen WebSocket Listeners useEffect] Cleaning up...')
      socketInstance.off('room-state', handleRoomState)
      socketInstance.off('user-joined', handleUserJoined)
      socketInstance.off('user-left', handleUserLeft)
      socketInstance.off('screen-share-status', handleScreenShareStatus)
    }
  }, [
    socketInstance,
    // ↓↓↓ 依存配列を socketInstance のみに変更 ↓↓↓
    // callPeerHook,
    // upsertParticipant,
    // screenShareStream,
    // screenSharingPeerId,
    // myPeerIdFromHook,
  ]) // ★ 依存配列は socketInstance のみ

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

  const calledExistingPeersRef = useRef(false)
  useEffect(() => {
    // myPeerIdFromHook が確定し、まだ呼んでいない場合
    if (myPeerIdFromHook && !calledExistingPeersRef.current) {
      const otherParticipants = participants.filter(
        (p) => !p.isSelf && p.id !== myPeerIdFromHook
      )

      if (otherParticipants.length > 0) {
        console.log(
          '[CallScreen] Calling existing participants ONCE after MyPeerId is set:',
          otherParticipants.map((p) => p.id)
        )
        otherParticipants.forEach((p) => {
          // ★ Ref 経由で callPeerHook を呼ぶ
          callPeerHookRef
            .current?.(p.id)
            .catch((error) =>
              console.error(
                `[CallScreen] Failed to call existing peer ${p.id} after MyPeerId set:`,
                error
              )
            )
        })
        calledExistingPeersRef.current = true
      }
    }
    // ★ callPeerHook を依存配列から削除
  }, [myPeerIdFromHook, participants])

  useEffect(() => {
    const screenVideoElement = screenVideoRef.current
    const socketInstanceToDisconnect = socketRef.current

    return () => {
      console.log('CallScreen: Component unmounting, disconnecting everything.')

      if (screenVideoElement && screenVideoElement.srcObject) {
        console.log('CallScreen: Stopping screen share stream on unmount.')
        const stream = screenVideoElement.srcObject as MediaStream
        stream?.getTracks().forEach((track) => track.stop())
        screenVideoElement.srcObject = null
      }

      if (socketInstanceToDisconnect) {
        console.log('CallScreen: Disconnecting socket on unmount.')
        socketInstanceToDisconnect.disconnect()
        socketRef.current = null
      }

      console.log('CallScreen: Cleanup on unmount finished.')
    }
  }, [])

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

  useEffect(() => {
    getDevices()
  }, [getDevices])

  useEffect(() => {
    console.log(
      `[CallScreen Activate Effect] Running. Sharer: ${screenSharingPeerId}, Pending keys: ${Object.keys(pendingScreenStreams)}`
    )

    if (screenSharingPeerId) {
      const pendingStream = pendingScreenStreams[screenSharingPeerId]
      if (pendingStream) {
        if (screenShareStream !== pendingStream) {
          console.log(
            `[CallScreen Activate Effect] Activating pending stream for ${screenSharingPeerId}.`
          )

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

          setScreenShareStream(pendingStream)
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
        if (!screenShareStream) {
          console.log(
            `[CallScreen Activate Effect] Sharer is ${screenSharingPeerId}, but no pending stream found and no active stream. Setting stream to null (waiting).`
          )
        } else {
          console.log(
            `[CallScreen Activate Effect] Sharer is ${screenSharingPeerId}, no pending stream, but a stream is already active.`
          )
        }
      }
    } else {
      if (screenShareStream) {
        console.log(
          '[CallScreen Activate Effect] No sharer, clearing active screen stream.'
        )
        setScreenShareStream(null)
      }
      if (Object.keys(pendingScreenStreams).length > 0) {
        console.warn(
          '[CallScreen Activate Effect] No sharer, but pending streams exist. Cleaning up pending streams.'
        )
        setPendingScreenStreams((prev) => {
          Object.values(prev).forEach((stream) =>
            stream.getTracks().forEach((track) => track.stop())
          )
          return {}
        })
      }
    }
  }, [screenSharingPeerId, pendingScreenStreams, screenShareStream]) // ★ pendingScreenStreams を依存配列に追加

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
      if (screenVideoRef.current) {
        screenVideoRef.current.srcObject = null
      }
    }
  }, [screenShareStream, screenVolume])

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

  const isScreenSharingMyself = useMemo(
    () => screenSharingPeerId === myPeerIdFromHook && myPeerIdFromHook !== '',
    [screenSharingPeerId, myPeerIdFromHook]
  )
  const isScreenShareButtonDisabled = useMemo(() => {
    return screenSharingPeerId !== null && !isScreenSharingMyself
  }, [screenSharingPeerId, isScreenSharingMyself])

  // --- JSX レンダリング ---
  return (
    <div className={styles.container}>
      {/* 参加者リスト */}
      <div className={styles.participantListContainer}>
        {' '}
        {/* 必要ならコンテナで囲む */}
        <ParticipantList
          participants={participants}
          myPeerId={myPeerIdFromHook}
          screenSharingPeerId={screenSharingPeerId}
          participantVolumes={participantVolumes}
          onVolumeChange={handleVolumeChange}
          selectedSpeakerId={selectedSpeakerId}
        />
      </div>

      {/* 画面共有表示エリア */}
      <div className={styles.screenShareArea}>
        {(() => {
          if (isScreenSharingMyself && localScreenStreamFromHook) {
            return (
              <video
                ref={localScreenPreviewRef}
                className={styles.localScreenPreview}
                autoPlay
                playsInline
                muted
              />
            )
          } else if (
            screenSharingPeerId &&
            screenSharingPeerId !== myPeerIdFromHook &&
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
          } else if (
            screenSharingPeerId &&
            screenSharingPeerId !== myPeerIdFromHook &&
            !screenShareStream
          ) {
            return (
              <div className={styles.loadingScreenShare}>
                画面を読み込み中...
              </div>
            )
          } else {
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
        // isScreenSharing={isScreenSharingMyself} // isScreenSharingMyself を計算して渡す
        isScreenSharing={
          screenSharingPeerId === myPeerIdFromHook && myPeerIdFromHook !== ''
        }
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
        myPeerId={myPeerIdFromHook}
        participants={participants}
        roomCode={roomCode}
        screenVolume={screenVolume}
        handleScreenVolumeChange={handleScreenVolumeChange}
        // isScreenShareButtonDisabled={isScreenShareButtonDisabled} // isScreenShareButtonDisabled を計算して渡す
        isScreenShareButtonDisabled={
          screenSharingPeerId !== null &&
          screenSharingPeerId !== myPeerIdFromHook
        }
      />

      {/* オーディオ要素用コンテナ */}
      <div id='audio-container' style={{ display: 'none' }}></div>
    </div>
  )
}
