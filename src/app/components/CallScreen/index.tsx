// src/app/components/CallScreen/index.tsx
'use client'
import styles from './styles.module.css'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import CallControlsFooter from '../CallControlsFooter'
import { usePeerConnection } from '@/app/hooks/usePeerConnection'
import { FiMicOff, FiMonitor } from 'react-icons/fi'
import { toast } from 'react-toastify'
import ParticipantList from '../ParticipantList'
import ScreenShareDisplay from '../ScreenShareDisplay'
import { useWebSocket } from '@/app/hooks/useWebSocket'
import type { Socket } from 'socket.io-client'

// 型定義は別ファイル (e.g., src/app/types.ts) に切り出すのが望ましい
import type {
  Participant,
  RoomStatePayload,
  ScreenShareStatusPayload,
  UserJoinedPayload,
  LocalAudioAnalysisRefs,
  DisconnectReason,
} from '../../type'

export default function CallScreen() {
  const { room: roomCodeParam } = useParams()
  const roomCode = Array.isArray(roomCodeParam)
    ? roomCodeParam[0]
    : roomCodeParam
  const router = useRouter()

  // --- State と Ref 定義 ---
  const [myName] = useState(() => localStorage.getItem('my_name') || '')
  const [participants, setParticipants] = useState<Participant[]>([])
  const [isMuted, setIsMuted] = useState(false)
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([])
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([])
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
  const [pendingScreenStreams, setPendingScreenStreams] = useState<{
    [peerId: string]: MediaStream
  }>({})

  // --- コールバック関数用 Ref ---
  // PeerConnection 用
  const onRemoteStreamRef = useRef<
    ((stream: MediaStream, peerId: string) => void) | undefined
  >(undefined) // ★ 型に | undefined を追加し、引数に undefined
  const onRemoteScreenStreamUpdateRef = useRef<
    ((stream: MediaStream, peerId: string) => void) | undefined
  >(undefined) // ★ 型に | undefined を追加し、引数に undefined
  const onParticipantUpdateRef = useRef<
    | ((participantData: Partial<Participant> & { id: string }) => void)
    | undefined
  >(undefined) // ★ 型に | undefined を追加し、引数に undefined
  const onParticipantRemoveRef = useRef<((peerId: string) => void) | undefined>(
    undefined
  ) // ★ 型に | undefined を追加し、引数に undefined
  const callPeerHookRef = useRef<
    ((peerId: string) => Promise<void>) | undefined
  >(undefined) // ★ 型に | undefined を追加し、引数に undefined
  // WebSocket 用
  const onRoomStateRef = useRef<
    ((payload: RoomStatePayload) => void) | undefined
  >(undefined) // ★ 型に | undefined を追加し、引数に undefined
  const onUserJoinedRef = useRef<
    ((payload: UserJoinedPayload) => void) | undefined
  >(undefined) // ★ 型に | undefined を追加し、引数に undefined
  const onUserLeftRef = useRef<((peerId: string) => void) | undefined>(
    undefined
  ) // ★ 型に | undefined を追加し、引数に undefined
  const onScreenShareStatusRef = useRef<
    ((payload: ScreenShareStatusPayload) => void) | undefined
  >(undefined) // ★ 型に | undefined を追加し、引数に undefined
  const onWebSocketConnectErrorRef = useRef<
    ((error: Error) => void) | undefined
  >(undefined) // ★ 型に | undefined を追加し、引数に undefined
  const onWebSocketDisconnectRef = useRef<
    ((reason: Socket.DisconnectReason) => void) | undefined
  >(undefined) // ★ 型に | undefined を追加し、引数に undefined

  // --- フック呼び出し (useCallback より前) ---
  const { socketInstance, emitJoinRoom } = useWebSocket({
    roomCode,
    onRoomState: (payload) => onRoomStateRef.current?.(payload),
    onUserJoined: (payload) => onUserJoinedRef.current?.(payload),
    onUserLeft: (peerId) => onUserLeftRef.current?.(peerId),
    onScreenShareStatus: (payload) => onScreenShareStatusRef.current?.(payload),
    onConnectError: (error) => onWebSocketConnectErrorRef.current?.(error),
    onDisconnect: (reason) => onWebSocketDisconnectRef.current?.(reason),
  })

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
    onRemoteStream: (...args) => onRemoteStreamRef.current?.(...args),
    onRemoteScreenStreamUpdate: (...args) =>
      onRemoteScreenStreamUpdateRef.current?.(...args),
    onParticipantUpdate: (...args) => onParticipantUpdateRef.current?.(...args),
    onParticipantRemove: (...args) => onParticipantRemoveRef.current?.(...args),
  })

  // --- コールバック関数 (useCallback でメモ化) ---

  // PeerConnection から呼ばれるコールバック

  const upsertParticipant = useCallback(
    (participantData: Partial<Participant> & { id: string }) => {
      setParticipants((prev) => {
        const existingIndex = prev.findIndex((p) => p.id === participantData.id)
        const isSelf =
          participantData.isSelf ?? participantData.id === myPeerIdFromHook

        console.log(
          `[CallScreen upsertParticipant] Data:`,
          participantData,
          `Calculated isSelf: ${isSelf}`
        )

        if (existingIndex !== -1) {
          return prev.map((p, i) =>
            i === existingIndex
              ? { ...p, ...participantData, isSelf: isSelf }
              : p
          )
        } else {
          if (isSelf && prev.some((p) => p.isSelf)) {
            console.warn(
              `[CallScreen upsertParticipant] Trying to add self again? ID: ${participantData.id}. Updating existing self.`
            )
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
            isSelf: isSelf,
            stream: participantData.stream ?? null,
            isSpeaking: participantData.isSpeaking ?? false,
          }
          return [...prev, newParticipant]
        }
      })
    },
    [myPeerIdFromHook]
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
      upsertParticipant({ id: peerId, stream }) // upsertParticipant を使用
    },
    [screenSharingPeerId, upsertParticipant] // screenSharingPeerId と upsertParticipant に依存
  )

  const handleReceiveScreenStream = useCallback(
    (stream: MediaStream, peerId: string) => {
      console.log(
        `★★★ [CallScreen] handleReceiveScreenStream called! PeerId: ${peerId}, Stream ID: ${stream.id}`
      )
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
    [screenSharingPeerId] // screenSharingPeerId に依存
  )

  // WebSocket から呼ばれるコールバック
  const handleRoomState = useCallback(
    (payload: RoomStatePayload) => {
      console.log(
        '★★★ [CallScreen] Received room-state event payload:',
        payload
      )
      const { participants: serverParticipants, currentSharerId } = payload
      const currentMyPeerId = myPeerIdFromHook

      // ↓↓↓ setParticipants をコールバック形式で呼び出すように変更 ↓↓↓
      setParticipants((prevParticipants) => {
        // ★ prevParticipants を受け取る
        const updatedParticipants: Participant[] = Object.entries(
          serverParticipants
        ).map(
          ([peerId, name]): Participant => ({
            id: peerId,
            name,
            isMuted: false,
            isSelf: peerId === currentMyPeerId,
            // 既存のストリームを維持 (prevParticipants を参照)
            stream:
              prevParticipants.find((p) => p.id === peerId)?.stream ?? null, // ★ prevParticipants を使用
            isSpeaking: false,
          })
        )

        if (
          currentMyPeerId &&
          !updatedParticipants.some((p) => p.id === currentMyPeerId)
        ) {
          updatedParticipants.push({
            id: currentMyPeerId,
            name: myName,
            isMuted: isMuted,
            isSelf: true,
            stream: localStream,
            isSpeaking: localAudioAnalysis.current.isSpeaking,
          })
        }
        return updatedParticipants // ★ 新しい配列を返す
      })
      // ↑↑↑ setParticipants をコールバック形式で呼び出すように変更 ↑↑↑

      setScreenSharingPeerId(currentSharerId)
    },
    // ↓↓↓ 依存配列から participants を削除 ↓↓↓
    [myPeerIdFromHook, myName, isMuted, localStream, localAudioAnalysis] // ★ participants を削除
  )

  const handleUserJoined = useCallback(
    (payload: UserJoinedPayload) => {
      const { peerId, name } = payload
      const currentMyPeerId = myPeerIdFromHook
      if (peerId === currentMyPeerId) return
      console.log(
        `★★★ [CallScreen] Received user-joined event via WebSocket: ${name} (${peerId})`
      )
      upsertParticipant({ id: peerId, name, isMuted: false, isSelf: false })
      callPeerHookFromHook(peerId).catch((error) =>
        console.error(
          `[CallScreen user-joined] Failed to call new peer ${peerId}:`,
          error
        )
      )
    },
    [myPeerIdFromHook, upsertParticipant, callPeerHookFromHook]
  )

  const handleUserLeft = useCallback(
    (peerId: string) => {
      console.log(
        `★★★ [CallScreen] Received user-left event via WebSocket: ${peerId}`
      )
      removePeer(peerId) // ★ サーバーからの退出通知で参加者を削除
    },
    [removePeer]
  ) // ★ removePeer を依存配列に追加

  const handleScreenShareStatus = useCallback(
    (payload: ScreenShareStatusPayload) => {
      console.log(
        '★★★ [CallScreen] Received screen-share-status event via WebSocket:',
        payload
      )
      const { peerId, isSharing, sharerPeerId: currentSharerId } = payload
      const currentMyPeerId = myPeerIdFromHook

      setScreenSharingPeerId(currentSharerId)
      setIsScreenSharing(currentSharerId === currentMyPeerId)

      if (!isSharing && screenShareStream && screenSharingPeerId === peerId) {
        console.log(
          `[CallScreen screen-share-status] Clearing remote screen stream because ${peerId} stopped sharing.`
        )
        setScreenShareStream(null)
      }
    },
    [myPeerIdFromHook, screenShareStream, screenSharingPeerId]
  )

  const handleWebSocketConnectError = useCallback(
    (error: Error) => {
      toast.error('サーバーとの接続に失敗しました。')
      // router.push('/'); // 必要ならリダイレクト
    },
    [
      /* router */
    ]
  )

  const handleWebSocketDisconnect = useCallback(
    (reason: Socket.DisconnectReason) => {
      // toast.info('サーバーから切断されました。')
      console.log(`[CallScreen] WebSocket disconnected: ${reason}`)

      setParticipants([])
      setScreenSharingPeerId(null)
      setScreenShareStream(null)
      if (screenVideoRef.current) screenVideoRef.current.srcObject = null
    },
    []
  )

  // UI 操作関連のコールバック
  const handleVolumeChange = useCallback((peerId: string, volume: number) => {
    setParticipantVolumes((prev) => ({ ...prev, [peerId]: volume }))
  }, [])

  const getDevices = useCallback(async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true, video: false }) // ★ アクセス許可を先に求める
      const devices = await navigator.mediaDevices.enumerateDevices()
      const mics = devices.filter((device) => device.kind === 'audioinput')
      const spkrs = devices.filter((device) => device.kind === 'audiooutput')

      console.log('[CallScreen getDevices] Microphones found:', mics)
      console.log('[CallScreen getDevices] Speakers found:', spkrs)

      setMicrophones(mics)
      setSpeakers(spkrs)

      if (!selectedSpeakerId && spkrs.length > 0) {
        const defaultSpeaker =
          spkrs.find((spk) => spk.deviceId === 'default') || spkrs[0]
        setSelectedSpeakerId(defaultSpeaker.deviceId)
        console.log(
          '[CallScreen getDevices] Setting default Speaker ID:',
          defaultSpeaker.deviceId
        )
      }
    } catch (err) {
      console.error('Error enumerating devices:', err)
      // ★ エラー発生時はリストを空にするか、ユーザーに通知
      setMicrophones([])
      setSpeakers([])
      toast.error(
        'マイク・スピーカーの取得に失敗しました。アクセス許可を確認してください。'
      )
    }
  }, [selectedSpeakerId])

  const stopLocalAudioAnalysis = useCallback(() => {
    if (localAudioAnalysis.current.animationFrameId) {
      cancelAnimationFrame(localAudioAnalysis.current.animationFrameId)
      localAudioAnalysis.current.animationFrameId = null
    }
    if (localAudioAnalysis.current.source) {
      localAudioAnalysis.current.source.disconnect()
      localAudioAnalysis.current.source = null
    }
    if (localAudioAnalysis.current.analyser) {
      localAudioAnalysis.current.analyser.disconnect()
      localAudioAnalysis.current.analyser = null
    }

    localAudioAnalysis.current.isSpeaking = false
    // 自分の発言状態を更新 (upsertParticipant を使う)
    if (myPeerIdFromHook) {
      upsertParticipant({ id: myPeerIdFromHook, isSpeaking: false })
    }
    console.log('[CallScreen] Stopped local audio analysis.')
  }, [myPeerIdFromHook, upsertParticipant])

  const startLocalAudioAnalysis = useCallback(
    (stream: MediaStream) => {
      // ↓↓↓ startLocalAudioAnalysis の実装を追加 ↓↓↓
      if (!stream || !stream.getAudioTracks().length) {
        console.warn(
          '[CallScreen] Cannot start audio analysis: No audio track found.'
        )
        return
      }
      if (localAudioAnalysis.current.animationFrameId) {
        console.warn('[CallScreen] Audio analysis already running.')
        return // すでに実行中なら何もしない
      }

      console.log('[CallScreen] Starting local audio analysis...')

      try {
        // AudioContext を取得または作成
        const context = localAudioAnalysis.current.context || new AudioContext()
        localAudioAnalysis.current.context = context

        // AnalyserNode を作成・設定
        const analyser = context.createAnalyser()
        analyser.fftSize = 256 // 高速フーリエ変換のサイズ
        const bufferLength = analyser.frequencyBinCount
        const dataArray = new Uint8Array(bufferLength)
        localAudioAnalysis.current.analyser = analyser
        localAudioAnalysis.current.dataArray = dataArray

        // MediaStreamSource を作成・接続
        const source = context.createMediaStreamSource(stream)
        localAudioAnalysis.current.source = source
        source.connect(analyser)
        // analyser はどこにも接続しない (音を聞く必要はないため)

        let consecutiveSilenceFrames = 0
        const silenceThresholdFrames = 10 // 静音と判定するまでのフレーム数
        let consecutiveSpeakingFrames = 0
        const speakingThresholdFrames = 3 // 発言と判定するまでのフレーム数

        const analyse = () => {
          if (
            !localAudioAnalysis.current.analyser ||
            !localAudioAnalysis.current.dataArray
          ) {
            console.warn(
              '[CallScreen analyse] Analyser or dataArray not available.'
            )
            localAudioAnalysis.current.animationFrameId = null // 念のためクリア
            return
          }

          localAudioAnalysis.current.analyser.getByteFrequencyData(
            localAudioAnalysis.current.dataArray
          )

          // 簡単な音量計算 (周波数データの平均値)
          let sum = 0
          for (let i = 0; i < bufferLength; i++) {
            sum += localAudioAnalysis.current.dataArray[i]
          }
          const average = sum / bufferLength

          let currentIsSpeaking = localAudioAnalysis.current.isSpeaking

          if (average > localSpeakingThreshold) {
            consecutiveSilenceFrames = 0 // 無音フレームカウントリセット
            consecutiveSpeakingFrames++
            if (
              consecutiveSpeakingFrames >= speakingThresholdFrames &&
              !currentIsSpeaking
            ) {
              currentIsSpeaking = true
            }
          } else {
            consecutiveSpeakingFrames = 0 // 発言フレームカウントリセット
            consecutiveSilenceFrames++
            if (
              consecutiveSilenceFrames >= silenceThresholdFrames &&
              currentIsSpeaking
            ) {
              currentIsSpeaking = false
            }
          }

          // 状態が変わった場合のみ更新
          if (currentIsSpeaking !== localAudioAnalysis.current.isSpeaking) {
            localAudioAnalysis.current.isSpeaking = currentIsSpeaking
            console.log(
              `[CallScreen analyse] Speaking state changed: ${currentIsSpeaking}`
            )
            // 自分の発言状態を更新
            if (myPeerIdFromHook) {
              upsertParticipant({
                id: myPeerIdFromHook,
                isSpeaking: currentIsSpeaking,
              })
            }
          }

          // 次のフレームをリクエスト
          localAudioAnalysis.current.animationFrameId =
            requestAnimationFrame(analyse)
        }

        // 解析開始
        localAudioAnalysis.current.animationFrameId =
          requestAnimationFrame(analyse)
      } catch (error) {
        console.error('[CallScreen] Error starting audio analysis:', error)
        stopLocalAudioAnalysis() // エラー時は停止処理を試みる
      }
    },
    [
      localSpeakingThreshold,
      stopLocalAudioAnalysis,
      myPeerIdFromHook,
      upsertParticipant,
    ]
  )

  const handleSpeakerChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const newSpeakerId = event.target.value
      setSelectedSpeakerId(newSpeakerId)
      // ParticipantList 内の useEffect で SinkID が設定される
    },
    []
  )

  const leaveRoom = useCallback(() => {
    router.push('/')
  }, [router])

  const toggleMic = useCallback(() => {
    if (!localStream) return
    const audioTrack = localStream.getAudioTracks()[0]
    if (audioTrack) {
      const newEnabledState = !audioTrack.enabled
      audioTrack.enabled = newEnabledState
      const newMuteState = !newEnabledState
      setIsMuted(newMuteState)
      if (myPeerIdFromHook) {
        upsertParticipant({ id: myPeerIdFromHook, isMuted: newMuteState })
      }
      sendMuteStatusHook(newMuteState)
    }
  }, [localStream, sendMuteStatusHook, myPeerIdFromHook, upsertParticipant])

  const toggleScreenShare = useCallback(async () => {
    const currentlySharing =
      screenSharingPeerId === myPeerIdFromHook && myPeerIdFromHook !== ''

    if (currentlySharing) {
      try {
        await stopScreenShareHook()
      } catch (error) {
        console.error('CallScreen: Failed to stop screen share:', error)
        toast.error(
          `画面共有の停止失敗: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    } else {
      if (screenSharingPeerId !== null) {
        toast.warn('現在他のユーザーが画面共有中です。')
        return
      }
      try {
        await startScreenShareHook()
      } catch (error) {
        console.error('CallScreen: Failed to start screen share:', error)
        if (error instanceof Error && error.name !== 'NotAllowedError') {
          toast.error(`画面共有の開始失敗: ${error.message}`)
        }
      }
    }
  }, [
    screenSharingPeerId,
    myPeerIdFromHook,
    startScreenShareHook,
    stopScreenShareHook,
  ])

  // --- useEffect フック ---

  // Ref を最新の関数で更新する Effect
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
  useEffect(() => {
    onRoomStateRef.current = handleRoomState
  }, [handleRoomState])
  useEffect(() => {
    onUserJoinedRef.current = handleUserJoined
  }, [handleUserJoined])
  useEffect(() => {
    onUserLeftRef.current = handleUserLeft
  }, [handleUserLeft])
  useEffect(() => {
    onScreenShareStatusRef.current = handleScreenShareStatus
  }, [handleScreenShareStatus])
  useEffect(() => {
    onWebSocketConnectErrorRef.current = handleWebSocketConnectError
  }, [handleWebSocketConnectError])
  useEffect(() => {
    onWebSocketDisconnectRef.current = handleWebSocketDisconnect
  }, [handleWebSocketDisconnect])

  // join-room を emit する Effect
  useEffect(() => {
    if (myPeerIdFromHook && myName) {
      emitJoinRoom(myPeerIdFromHook, myName)
    }
  }, [myPeerIdFromHook, myName, emitJoinRoom])

  // localStream 変更時に音声解析を開始/停止
  useEffect(() => {
    if (localStream) {
      startLocalAudioAnalysis(localStream)
    } else {
      stopLocalAudioAnalysis()
    }
  }, [localStream, startLocalAudioAnalysis, stopLocalAudioAnalysis])

  // 既存参加者を呼ぶ Effect
  const calledExistingPeersRef = useRef(false)
  useEffect(() => {
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
  }, [myPeerIdFromHook, participants])

  // アンマウント時のクリーンアップ
  useEffect(() => {
    const screenVideoElement = screenVideoRef.current
    return () => {
      console.log(
        'CallScreen: Component unmounting, cleaning up remaining resources.'
      )
      if (screenVideoElement && screenVideoElement.srcObject) {
        const stream = screenVideoElement.srcObject as MediaStream
        stream?.getTracks().forEach((track) => track.stop())
        screenVideoElement.srcObject = null
      }
      console.log('CallScreen: Cleanup on unmount finished.')
    }
  }, [])

  // participantVolumes 初期化
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

  // デバイス取得
  useEffect(() => {
    getDevices()
  }, [getDevices])

  // 画面共有ストリーム関連 Effect
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
          setScreenShareStream(pendingStream)
          setPendingScreenStreams((prev) => {
            const newState = { ...prev }
            delete newState[screenSharingPeerId]
            return newState
          })
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
  }, [screenSharingPeerId, pendingScreenStreams, screenShareStream])

  useEffect(() => {
    if (screenVideoRef.current && screenShareStream) {
      screenVideoRef.current.srcObject = screenShareStream
      screenVideoRef.current.muted = false
      screenVideoRef.current
        .play()
        .catch((e) => console.error('Screen share video play failed:', e))
    } else if (screenVideoRef.current) {
      screenVideoRef.current.srcObject = null
    }
  }, [screenShareStream])

  useEffect(() => {
    if (
      localScreenPreviewRef.current &&
      isScreenSharing &&
      localScreenStreamFromHook
    ) {
      localScreenPreviewRef.current.srcObject = localScreenStreamFromHook
      localScreenPreviewRef.current.muted = true
      localScreenPreviewRef.current
        .play()
        .catch((e) => console.error('Local screen preview play failed:', e))
    } else if (localScreenPreviewRef.current) {
      localScreenPreviewRef.current.srcObject = null
    }
  }, [isScreenSharing, localScreenStreamFromHook])

  // --- useMemo ---
  const isScreenSharingMyself = useMemo(
    () => screenSharingPeerId === myPeerIdFromHook && myPeerIdFromHook !== '',
    [screenSharingPeerId, myPeerIdFromHook]
  )
  const isScreenShareButtonDisabled = useMemo(
    () => screenSharingPeerId !== null && !isScreenSharingMyself,
    [screenSharingPeerId, isScreenSharingMyself]
  )

  // --- JSX レンダリング ---
  return (
    <div className={styles.container}>
      <div className={styles.participantListContainer}>
        <ParticipantList
          participants={participants}
          myPeerId={myPeerIdFromHook}
          screenSharingPeerId={screenSharingPeerId}
          selectedSpeakerId={selectedSpeakerId}
        />
      </div>
      <div className={styles.screenShareArea}>
        <ScreenShareDisplay
          screenSharingPeerId={screenSharingPeerId}
          myPeerId={myPeerIdFromHook}
          localScreenStream={localScreenStreamFromHook}
          remoteScreenStream={screenShareStream}
          screenVideoRef={screenVideoRef}
          localScreenPreviewRef={localScreenPreviewRef}
        />
      </div>
      <CallControlsFooter
        isMuted={isMuted}
        isScreenSharing={isScreenSharingMyself}
        microphones={microphones}
        speakers={speakers}
        selectedSpeakerId={selectedSpeakerId}
        localStream={localStream}
        toggleMic={toggleMic}
        toggleScreenShare={toggleScreenShare}
        handleSpeakerChange={handleSpeakerChange}
        switchMicrophone={switchMicrophoneHook} // ★ マイク切り替え関数を渡す
        stopLocalAudioAnalysis={stopLocalAudioAnalysis} // ★ 音声解析停止関数を渡す
        leaveRoom={leaveRoom}
        screenSharingPeerId={screenSharingPeerId}
        myPeerId={myPeerIdFromHook}
        participants={participants}
        roomCode={roomCode}
        screenVideoRef={screenVideoRef}
        isScreenShareButtonDisabled={isScreenShareButtonDisabled}
      />
      {/* <div id='audio-container' style={{ display: 'none' }}></div> */}
    </div>
  )
}

// ★ 型定義は別ファイルに移動することを推奨
// type JoinRoomPayload = { /* ... */ };
