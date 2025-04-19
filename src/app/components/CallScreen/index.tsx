// src/app/components/CallScreen/index.tsx
'use client'
import styles from './styles.module.css'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState, useRef, useCallback, useMemo } from 'react' // Dispatch, SetStateAction をインポート
import io, { Socket } from 'socket.io-client'
import CallControlsFooter from '../CallControlsFooter' // パスを確認してください
import { usePeerConnection } from '@/app/hooks/usePeerConnection'
import { FiMicOff, FiMonitor } from 'react-icons/fi'
// ★ 任意: アイコンを使う場合
// import { ComputerDesktopIcon, StopCircleIcon } from '@heroicons/react/24/outline';

// WebSocket サーバーの URL
const WEBSOCKET_SERVER_URL =
  process.env.NEXT_PUBLIC_WEBSOCKET_SERVER_URL || 'http://localhost:3001'

// --- インターフェース定義 ---
export interface Participant {
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
  const [socketInstance, setSocketInstance] = useState<Socket | null>(null) // ★ Socket state
  const [myName] = useState(() => localStorage.getItem('my_name') || '')
  const [participants, setParticipants] = useState<Participant[]>([])
  const audioRefs = useRef<{ [id: string]: HTMLAudioElement }>({})
  const [isMuted, setIsMuted] = useState(false)
  const localStreamRef = useRef<MediaStream | null>(null)
  const myPeerIdRef = useRef<string>('') // Peer ID を Ref で保持
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
  }, [participantVolumes]) // participantVolumes が更新されたら Ref も更新

  const localSpeakingThreshold = 10

  const [isScreenSharing, setIsScreenSharing] = useState(false) // 自分が共有中か
  const [screenSharingPeerId, setScreenSharingPeerId] = useState<string | null>(
    null
  )
  const screenVideoRef = useRef<HTMLVideoElement>(null)
  const [screenShareStream, setScreenShareStream] =
    useState<MediaStream | null>(null)
  const localScreenPreviewRef = useRef<HTMLVideoElement>(null)
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string>('')
  // ★ selectedSpeakerId の最新値を保持する Ref を追加
  const selectedSpeakerIdRef = useRef(selectedSpeakerId)
  useEffect(() => {
    selectedSpeakerIdRef.current = selectedSpeakerId
  }, [selectedSpeakerId]) // selectedSpeakerId が更新されたら Ref も更新
  const [screenVolume, setScreenVolume] = useState(0.7) // 初期音量 (0.0 ~ 1.0)

  // --- ここまで State と Ref 定義 ---

  // --- コールバック関数 (usePeerConnection に渡すもの) ---

  const handleReceiveAudioStream = useCallback(
    (stream: MediaStream, peerId: string) => {
      console.log(`CallScreen: Received audio stream from ${peerId}`)
      if (!audioRefs.current[peerId]) {
        const audio = new Audio()
        audio.srcObject = stream
        audio.dataset.peerId = peerId
        const container = document.getElementById('audio-container')
        if (container) container.appendChild(audio)
        else document.body.appendChild(audio)
        audio.play().catch((e) => console.error('Audio play failed:', e))
        audioRefs.current[peerId] = audio

        const initialVolume = participantVolumesRef.current[peerId] ?? 1.0
        handleVolumeChange(peerId, initialVolume)

        if (
          selectedSpeakerIdRef.current &&
          typeof audio.setSinkId === 'function'
        ) {
          audio
            .setSinkId(selectedSpeakerIdRef.current)
            .catch((err) =>
              console.error('Failed to set sinkId on new audio:', err)
            )
        }
      }
    },
    [participantVolumesRef] // Ref は安定しているので依存配列に含めてもOK
  )
  // ★★★ ここまでが正しい AudioStream の処理 ★★★

  // ★ handleReceiveScreenStream の定義 (これは正しいはず)
  const handleReceiveScreenStream = useCallback(
    (stream: MediaStream, peerId: string) => {
      console.log(`CallScreen: Received screen share stream from ${peerId}`)
      setScreenShareStream(stream) // ★ state を更新するだけ
    },
    [] // 依存配列は空でOK
  )

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
      // ダミーストリームを取得してすぐに停止することで、デバイスへのアクセス許可をトリガー
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

      // 現在選択中のマイクがリストに存在するか確認し、なければデフォルトを設定
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

      // デフォルトスピーカーを設定
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
      // エラー処理 (例: ユーザーに通知)
    }
  }, []) // 依存配列は空

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
    // 自分の発言状態をリセット
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
          // 既存参加者の情報を更新
          const updatedParticipants = [...prev]
          const existingParticipant = updatedParticipants[existingIndex]
          updatedParticipants[existingIndex] = {
            ...existingParticipant,
            ...participantData,
            isSelf: existingParticipant.isSelf, // isSelf は上書きしない
          }
          newState = updatedParticipants
        } else {
          // 新規参加者を追加
          const newParticipant: Participant = {
            id: participantData.id,
            name: participantData.name || 'Unknown',
            isMuted: participantData.isMuted ?? false,
            isSelf: participantData.isSelf ?? false, // isSelf は usePeerConnection で設定される
            isSpeaking: participantData.isSpeaking ?? false,
          }
          newState = [...prev, newParticipant]
        }
        return newState
      })
    },
    [] // 依存配列は空
  )

  // startLocalAudioAnalysis
  const startLocalAudioAnalysis = useCallback(
    (stream: MediaStream) => {
      stopLocalAudioAnalysis() // 既存の分析を停止

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
        analyser.fftSize = 256 // FFTサイズ (周波数解像度)
        analyser.smoothingTimeConstant = 0.3 // 平滑化定数 (0-1)
        source.connect(analyser)
        const dataArray = new Uint8Array(analyser.frequencyBinCount) // 周波数データ用配列

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
          // コンテキストやアナライザーが破棄されていないか確認
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

          // 次のフレームで再度 analyse を実行
          analysis.animationFrameId = requestAnimationFrame(analyse)
          // 周波数データを取得
          analysis.analyser.getByteFrequencyData(analysis.dataArray)

          // 平均音量を計算 (簡易的な発話検出)
          let sum = 0
          for (let i = 0; i < analysis.dataArray.length; i++) {
            sum += analysis.dataArray[i]
          }
          const average = sum / analysis.dataArray.length
          const isSpeaking = average > localSpeakingThreshold // 閾値と比較

          // 発話状態が変化した場合のみ更新
          if (isSpeaking !== analysis.isSpeaking) {
            analysis.isSpeaking = isSpeaking
            if (myPeerIdRef.current) {
              // 自分の Participant オブジェクトの発話状態を更新
              setParticipants((prev) =>
                prev.map((p) =>
                  p.id === myPeerIdRef.current ? { ...p, isSpeaking } : p
                )
              )
            }
          }
        }
        analyse() // 分析開始
        console.log('CallScreen: Started local audio analysis.')
      } catch (error) {
        console.error('CallScreen: Error starting local audio analysis:', error)
        stopLocalAudioAnalysis() // エラー時は分析を停止
      }
    },
    [localSpeakingThreshold, stopLocalAudioAnalysis] // 依存配列
  )

  // handleSpeakerChange
  const handleSpeakerChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const newSpeakerId = event.target.value
      console.log('Selected Speaker ID:', newSpeakerId)
      setSelectedSpeakerId(newSpeakerId)

      // すべてのオーディオ要素の出力デバイスを変更
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
    [] // 依存配列は空
  )

  // removePeer
  const removePeer = useCallback(
    (peerId: string) => {
      console.log(`CallScreen: Removing peer: ${peerId}`)
      // 参加者リストから削除
      setParticipants((prev) => prev.filter((p) => p.id !== peerId))
      // オーディオ要素を削除
      if (audioRefs.current[peerId]) {
        const audio = audioRefs.current[peerId]
        audio.pause()
        audio.srcObject = null
        audio.remove()
        delete audioRefs.current[peerId]
        console.log(`CallScreen: Removed audio for peer: ${peerId}`)
      }
      // もし切断した人が画面共有中だったらクリア
      setScreenSharingPeerId((prevSharerId) => {
        if (prevSharerId === peerId) {
          setScreenShareStream(null)
          if (screenVideoRef.current) {
            screenVideoRef.current.srcObject = null
          }
          return null
        }
        return prevSharerId
      })
    },
    [] // 依存配列は空
  )

  // leaveRoom
  const leaveRoom = useCallback(() => {
    console.log('CallScreen: Leaving room...')
    router.push('/') // ホーム画面などに戻る
  }, [router])

  const handleScreenVolumeChange = useCallback((volume: number) => {
    // state を更新 (すぐに反映させるため)
    setScreenVolume(volume)
    // 実際のビデオ要素の音量を変更 (useEffect でも行うが、即時反映のためここでも)
    if (screenVideoRef.current) {
      screenVideoRef.current.volume = volume
    }
  }, []) // 依存配列は空でOK

  // --- usePeerConnection フックの呼び出し ---
  // ★ peerCallbacks の useMemo の依存配列も更新
  const peerCallbacks = useMemo(
    () => ({
      onReceiveAudioStream: handleReceiveAudioStream,
      onReceiveScreenStream: handleReceiveScreenStream,
      onParticipantUpdate: upsertParticipant,
      onParticipantRemove: removePeer,
      onScreenShareStatusChange: (
        ...args: Parameters<typeof handleScreenShareStatusChange>
      ) => handleScreenShareStatusChange(...args),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      handleReceiveAudioStream, // ★ 更新された関数を依存配列に追加
      handleReceiveScreenStream,
      upsertParticipant,
      removePeer,
    ]
  )

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
    isMuted,
    socket: socketInstance, // ★ socketInstance state を渡す
    ...peerCallbacks,
  })

  // --- フックの結果を使用するコールバック関数 ---

  // handleMicChange
  const handleMicChange = useCallback(
    async (event: React.ChangeEvent<HTMLSelectElement>) => {
      const newMicId = event.target.value
      const currentMicId = selectedMicId
      console.log('Selected Microphone ID:', newMicId)
      setSelectedMicId(newMicId)

      try {
        stopLocalAudioAnalysis() // マイク切り替え前に分析停止
        await switchMicrophoneHook(newMicId) // フックの関数を呼び出す
        console.log('Microphone switched successfully via hook')
        // 分析再開は localStream の useEffect で行う
      } catch (error) {
        console.error('Failed to switch microphone:', error)
        alert(
          `マイクの切り替えに失敗しました: ${error instanceof Error ? error.message : String(error)}`
        )
        setSelectedMicId(currentMicId) // エラー時は選択を元に戻す
        // エラー時も分析再開は localStream の useEffect で行う
      }
    },
    [
      selectedMicId,
      stopLocalAudioAnalysis,
      switchMicrophoneHook, // フックから取得した関数
    ]
  )

  // toggleMic
  const toggleMic = useCallback(() => {
    if (!localStream) return
    const audioTrack = localStream.getAudioTracks()[0]
    if (audioTrack) {
      const newEnabledState = !audioTrack.enabled
      audioTrack.enabled = newEnabledState // トラックの有効/無効を切り替え
      const newMuteState = !newEnabledState // isMuted state を更新
      setIsMuted(newMuteState)
      // 自分の参加者情報を更新
      setParticipants((prev) =>
        prev.map((p) => (p.isSelf ? { ...p, isMuted: newMuteState } : p))
      )
      sendMuteStatusHook(newMuteState) // 他のピアに状態を送信
      console.log('Mute status sent via hook:', newMuteState)
    }
  }, [localStream, sendMuteStatusHook]) // 依存配列

  // handleScreenShareStatusChange
  const handleScreenShareStatusChange = useCallback(
    (peerId: string, isSharing: boolean) => {
      console.log(
        `[CallScreen] Handling screen share status from ${peerId}: ${isSharing}`
      )
      if (isSharing) {
        setScreenSharingPeerId((prevSharerId) => {
          console.log(
            `[CallScreen] Updating screenSharingPeerId from ${prevSharerId} to ${peerId}`
          )
          if (prevSharerId !== peerId) {
            // 自分が共有中だったら停止
            if (prevSharerId === myPeerIdRef.current) {
              console.warn(
                `Peer ${peerId} started sharing, stopping local screen share.`
              )
              stopScreenShareHook().catch((err) =>
                console.error('Error stopping local share on conflict:', err)
              )
              setIsScreenSharing(false)
            }
            // 既存の共有ストリームがあればクリア
            setScreenShareStream((prevStream) => {
              if (prevStream) {
                console.log(
                  'Clearing previous screen share stream as sharer changed.'
                )
                prevStream.getTracks().forEach((track) => track.stop())
                if (screenVideoRef.current) {
                  screenVideoRef.current.srcObject = null
                }
              }
              return null // 新しいストリームは onReceiveScreenStream で設定される
            })
          }
          return peerId // 新しい共有者のIDを設定
        })
      } else {
        // 共有が停止された場合
        setScreenSharingPeerId((prevSharerId) => {
          if (prevSharerId === peerId) {
            console.log(
              `[CallScreen] Updating screenSharingPeerId from ${prevSharerId} to null`
            )
            console.log(
              `CallScreen: Peer ${peerId} stopped screen sharing, clearing stream.`
            )
            // ストリームをクリア
            setScreenShareStream((prevStream) => {
              if (prevStream) {
                prevStream.getTracks().forEach((track) => track.stop())
              }
              if (screenVideoRef.current) {
                screenVideoRef.current.srcObject = null
              }
              return null
            })
            return null // 共有者を null に設定
          }
          console.log(
            `[CallScreen] screenSharingPeerId remains ${prevSharerId} (stop event from different peer)`
          )
          return prevSharerId // 変更なし
        })
      }
    },
    [stopScreenShareHook] // stopScreenShareHook に依存
  )

  // toggleScreenShare
  const toggleScreenShare = useCallback(async () => {
    if (isScreenSharing) {
      // 共有中の場合: 停止
      try {
        await stopScreenShareHook()
        setIsScreenSharing(false)
        console.log('CallScreen: Screen sharing stopped via hook.')
      } catch (error) {
        console.error('CallScreen: Failed to stop screen share:', error)
        alert(
          `画面共有の停止に失敗しました: ${error instanceof Error ? error.message : String(error)}`
        )
        // エラーでも状態をリセットしておく
        setIsScreenSharing(false)
      }
    } else {
      // 共有中でない場合: 開始
      try {
        // 他の人が共有中なら警告 (処理は続行)
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
      } catch (error) {
        console.error('CallScreen: Failed to start screen share:', error)
        // NotAllowedError はユーザーがキャンセルした場合なのでアラートしない
        if (error instanceof Error && error.name !== 'NotAllowedError') {
          alert(`画面共有の開始に失敗しました: ${error.message}`)
        }
        setIsScreenSharing(false) // エラー時は状態をリセット
      }
    }
  }, [
    isScreenSharing,
    screenSharingPeerId,
    participants, // participants はログ表示にのみ使用
    startScreenShareHook,
    stopScreenShareHook,
  ]) // myPeerIdFromHook は不要 (myPeerIdRef.current で比較するため)

  // --- useEffect フック ---

  // myPeerIdRef の更新
  useEffect(() => {
    if (myPeerIdFromHook) {
      myPeerIdRef.current = myPeerIdFromHook
      // 自分の情報を Participant リストに追加/更新
      upsertParticipant({
        id: myPeerIdFromHook,
        name: myName,
        isMuted: isMuted,
        isSelf: true,
      })
    }
  }, [myPeerIdFromHook, myName, isMuted, upsertParticipant]) // isMuted, myName, upsertParticipant も依存配列に追加

  // localStreamRef の更新 & 音声分析開始/停止
  useEffect(() => {
    localStreamRef.current = localStream
    if (localStream) {
      startLocalAudioAnalysis(localStream)
    } else {
      stopLocalAudioAnalysis()
    }
    // クリーンアップ関数で分析を停止
    return () => {
      stopLocalAudioAnalysis()
    }
  }, [localStream, startLocalAudioAnalysis, stopLocalAudioAnalysis])

  // --- WebSocket 関連 useEffect (接続管理) ---
  useEffect(() => {
    console.log('[CallScreen WebSocket Connection useEffect] Initializing...')
    if (!roomCode) {
      console.error('Room code is missing.')
      router.push('/') // 必要ならリダイレクト
      return
    }

    // マウント状態を管理する Ref
    const isMounted = { current: true }

    // 既に接続済み、または接続試行中の場合は何もしない
    if (socketRef.current) {
      if (socketRef.current.connected && !socketInstance) {
        setSocketInstance(socketRef.current)
      }
      return
    }

    console.log('CallScreen: Initializing WebSocket connection...')
    const socket = io(WEBSOCKET_SERVER_URL)
    socketRef.current = socket // Ref に保持

    socket.on('connect', () => {
      console.log('★★★ CallScreen: WebSocket connected! Socket ID:', socket.id)
      if (isMounted.current) {
        setSocketInstance(socket) // State を更新
      }
    })

    socket.on('connect_error', (error) => {
      console.error('CallScreen: WebSocket connection error:', error)
      alert('サーバーとの接続に失敗しました。')
      socketRef.current = null // Ref をクリア
      if (isMounted.current) {
        setSocketInstance(null) // State をクリア
      }
    })

    socket.on('disconnect', (reason) => {
      console.log('CallScreen: WebSocket disconnected:', reason)
      if (isMounted.current) {
        setSocketInstance(null) // State をクリア
      }
      // CallScreen の他の State をリセット
      setParticipants([])
      myPeerIdRef.current = ''
      setScreenSharingPeerId(null)
      setScreenShareStream(null)
      if (screenVideoRef.current) screenVideoRef.current.srcObject = null
      // Ref もクリア
      socketRef.current = null
    })

    // クリーンアップ関数
    return () => {
      isMounted.current = false
      console.log('CallScreen: Cleaning up WebSocket Connection useEffect...')
      // アンマウント時に切断 (アンマウント用 useEffect で行うためコメントアウト)
      // socketRef.current?.disconnect();
      // socketRef.current = null;
    }
    // roomCode が変わることは想定しないが、念のため依存配列に含める
  }, [roomCode, router, socketInstance]) // socketInstance を依存配列に追加

  // --- WebSocket 関連 useEffect (リスナー設定) ---
  useEffect(() => {
    // socketInstance が null (未接続 or 切断) の場合はリスナーを設定しない
    if (!socketInstance) {
      return
    }

    console.log('[CallScreen WebSocket Listeners useEffect] Setting up...')

    const handleUserJoined = (payload: UserJoinedPayload) => {
      const { peerId, name } = payload
      // 自分の Peer ID と同じ場合は無視
      if (peerId === myPeerIdRef.current) return
      console.log(`CallScreen: User joined: ${name} (${peerId})`)
      upsertParticipant({ id: peerId, name, isMuted: false, isSelf: false })
      // 新規参加者に発信
      callPeerHook(peerId).catch((error) =>
        console.error(`CallScreen: Failed to call new peer ${peerId}:`, error)
      )
    }
    const handleUserLeft = (payload: UserLeftPayload) => {
      console.log(`CallScreen: User left: ${payload.peerId}`)
      // 参加者削除は PeerJS の onPeerDisconnect で処理されるため、ここでは何もしない
      // removePeer(payload.peerId);
    }
    const handleExistingParticipants = (
      payload: ExistingParticipantsPayload
    ) => {
      console.log('CallScreen: Received existing participants:', payload)
      const currentPeerId = myPeerIdRef.current
      const existingParticipants: Participant[] = Object.entries(payload)
        // 自分自身は除外
        .filter(([id]) => id !== currentPeerId)
        .map(([id, name]) => ({ id, name, isMuted: false, isSelf: false }))

      // 既存参加者をリストに追加/更新
      existingParticipants.forEach((p) => upsertParticipant(p))
      // 既存参加者に発信
      existingParticipants.forEach((p) => {
        callPeerHook(p.id).catch((error) =>
          console.error(
            `CallScreen: Failed to call existing peer ${p.id}:`,
            error
          )
        )
      })
    }

    socketInstance.on('user-joined', handleUserJoined)
    socketInstance.on('user-left', handleUserLeft)
    socketInstance.on('existing-participants', handleExistingParticipants)

    // クリーンアップ関数
    return () => {
      console.log('[CallScreen WebSocket Listeners useEffect] Cleaning up...')
      socketInstance.off('user-joined', handleUserJoined)
      socketInstance.off('user-left', handleUserLeft)
      socketInstance.off('existing-participants', handleExistingParticipants)
    }
    // socketInstance と、コールバック内で使う安定した関数に依存
  }, [socketInstance, upsertParticipant, callPeerHook])

  // --- WebSocket 関連 useEffect (join-room 送信) ---
  useEffect(() => {
    // socket と peerId の両方が準備できてから join-room を送信
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
  }, [socketInstance, myPeerIdFromHook, myName, roomCode]) // 必要な値すべてに依存

  // --- アンマウント用 useEffect ---
  useEffect(() => {
    return () => {
      console.log('CallScreen: Component unmounting, disconnecting everything.')
      // 受信画面共有ストリーム停止
      if (screenVideoRef.current && screenVideoRef.current.srcObject) {
        const stream = screenVideoRef.current.srcObject as MediaStream
        stream?.getTracks().forEach((track) => track.stop())
        screenVideoRef.current.srcObject = null
      }
      // WebSocket 切断
      socketRef.current?.disconnect()
      socketRef.current = null
      // PeerJS 切断 & リソース解放

      console.log('CallScreen: Disconnected socket and PeerJS on unmount.')
    }
  }, []) // アンマウント時に一度だけ実行

  // --- デフォルト音量設定 useEffect ---
  useEffect(() => {
    const newVolumes = { ...participantVolumes }
    let changed = false
    participants.forEach((p) => {
      // 自分以外の参加者で、まだ音量設定がない場合にデフォルト値(1.0)を設定
      if (!p.isSelf && !(p.id in newVolumes)) {
        newVolumes[p.id] = 1.0
        changed = true
      }
    })
    if (changed) {
      setParticipantVolumes(newVolumes)
    }
  }, [participants, participantVolumes]) // participants が変更されたら実行

  // --- デバイス取得 useEffect ---
  useEffect(() => {
    getDevices()
  }, [getDevices]) // getDevices は useCallback でラップされている

  // ★★★ 画面共有ストリームを video 要素に設定する useEffect を追加 ★★★
  useEffect(() => {
    if (screenVideoRef.current && screenShareStream) {
      console.log('CallScreen: Setting screen share stream to video element.')
      screenVideoRef.current.srcObject = screenShareStream
      screenVideoRef.current.play().catch((e) => {
        console.error('Screen share video play failed:', e)
        // 自動再生失敗時のフォールバック (例: ユーザーに再生ボタンを表示)
      })
    } else {
      // ストリームが null になった場合 (共有停止時など) は srcObject もクリア
      if (screenVideoRef.current) {
        screenVideoRef.current.srcObject = null
      }
    }
  }, [screenShareStream]) // screenShareStream が変更されたら実行
  // screenVideoRef は Ref なので依存配列に含める必要はない

  // ★★★ 受信画面共有ストリームを video 要素に設定する useEffect を修正 ★★★
  useEffect(() => {
    if (screenVideoRef.current && screenShareStream) {
      console.log('CallScreen: Setting screen share stream to video element.')
      screenVideoRef.current.srcObject = screenShareStream
      // ↓↓↓ 音量を state から設定 & ミュート解除 ↓↓↓
      screenVideoRef.current.volume = screenVolume
      screenVideoRef.current.muted = false // ★ ミュート解除
      // ↑↑↑ 音量を state から設定 & ミュート解除 ↑↑↑
      screenVideoRef.current.play().catch((e) => {
        console.error('Screen share video play failed:', e)
      })
    } else {
      if (screenVideoRef.current) {
        screenVideoRef.current.srcObject = null
      }
    }
  }, [screenShareStream, screenVolume]) // ★ screenVolume も依存配列に追加

  // ★★★ ローカル画面共有プレビュー用の useEffect (変更なし) ★★★

  // ★★★ ローカル画面共有プレビュー用の useEffect ★★★
  useEffect(() => {
    // ↓↓↓ これで localScreenPreviewRef が見つかるはず ↓↓↓
    if (
      localScreenPreviewRef.current &&
      isScreenSharing &&
      localScreenStreamFromHook
    ) {
      console.log('CallScreen: Setting local screen stream to preview element.')
      localScreenPreviewRef.current.srcObject = localScreenStreamFromHook
      localScreenPreviewRef.current.muted = true
      localScreenPreviewRef.current.play().catch((e) => {
        console.error('Local screen preview play failed:', e)
      })
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
                  {/* ★ 自分が画面共有中のアイコン */}
                  {p.id === screenSharingPeerId && (
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
                {/* ★ 他の参加者が画面共有中のアイコン */}
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
              {/* ★ ミュートアイコン (絶対配置) */}
              <FiMicOff className={styles.muteIndicatorIcon} />
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
          // 優先順位3: 共有ストリーム読み込み中 (任意)
          else if (
            isScreenSharing ||
            (screenSharingPeerId && screenSharingPeerId !== myPeerIdRef.current)
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
        myPeerId={myPeerIdRef.current} // Ref の現在の値を渡す
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
