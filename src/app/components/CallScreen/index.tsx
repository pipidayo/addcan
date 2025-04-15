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
} from '../PeerManager'
import io, { Socket } from 'socket.io-client'
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
  const initializedSocket = useRef(false)
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
  //  しきい値 (PeerManager と同じか、調整)
  const localSpeakingThreshold = 10

  const [isScreenSharing, setIsScreenSharing] = useState(false) // 自分が共有中か
  const [screenSharingPeerId, setScreenSharingPeerId] = useState<string | null>(
    null
  ) // 誰が共有中か

  // --- ここまで State と Ref 定義 ---

  // 音量変更ハンドラ
  const handleVolumeChange = (peerId: string, volume: number) => {
    // state を更新
    setParticipantVolumes((prev) => ({
      ...prev,
      [peerId]: volume,
    }))

    // 対応する audio 要素の音量を変更
    const audioElement = audioRefs.current[peerId]
    if (audioElement) {
      audioElement.volume = volume // volume は 0.0 ~ 1.0
    }
  }

  // --- デバイスリスト取得関数 ---
  const getDevices = useCallback(async () => {
    try {
      // ★★★ メディア権限を先に要求 (enumerateDevices だけだとラベルが空になることがあるため) ★★★
      // ダミーのストリームを取得してすぐに停止する
      const dummyStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      })
      dummyStream.getTracks().forEach((track) => track.stop())
      console.log(
        'CallScreen: Dummy stream acquired and stopped for device enumeration.'
      )

      const devices = await navigator.mediaDevices.enumerateDevices()
      const audioInputDevices = devices.filter(
        (device) => device.kind === 'audioinput'
      )
      const audioOutputDevices = devices.filter(
        (device) => device.kind === 'audiooutput'
      )
      setMicrophones(audioInputDevices)
      setSpeakers(audioOutputDevices)

      // デフォルトデバイスを選択 (もしあれば)
      const currentMic = localStreamRef.current
        ?.getAudioTracks()[0]
        ?.getSettings().deviceId
      if (
        currentMic &&
        audioInputDevices.some((d) => d.deviceId === currentMic)
      ) {
        setSelectedMicId(currentMic)
      } else if (audioInputDevices.length > 0) {
        setSelectedMicId(audioInputDevices[0].deviceId) // 最初のマイクをデフォルトに
      }

      // スピーカーのデフォルト選択 (通常 'default')
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
      // 必要に応じてユーザーにエラー通知
    }
  }, []) // 依存配列は空

  // --- マイク変更ハンドラ ---
  const handleMicChange = useCallback(
    async (event: React.ChangeEvent<HTMLSelectElement>) => {
      const newMicId = event.target.value
      const currentMicId = selectedMicId // 元のIDを保持
      console.log('Selected Microphone ID:', newMicId)
      setSelectedMicId(newMicId) // UI を先に更新

      // ★★★ PeerManager のマイク切り替え処理を呼び出す ★★★
      try {
        stopLocalAudioAnalysis()

        await switchMicrophone(newMicId) // PeerManager の関数を呼び出す
        console.log('Microphone switched successfully in PeerManager')

        setTimeout(() => {
          if (localStreamRef.current) {
            startLocalAudioAnalysis(localStreamRef.current)
          }
        }, 500) // 0.5秒待つ (仮)

        alert(
          `マイクを ${microphones.find((m) => m.deviceId === newMicId)?.label || '不明なデバイス'} に切り替えました`
        )
      } catch (error) {
        console.error('Failed to switch microphone:', error)
        alert(
          `マイクの切り替えに失敗しました: ${error instanceof Error ? error.message : String(error)}`
        )
        setSelectedMicId(currentMicId)
        // ★★★ エラー時も分析を再開（元のストリームで）★★★
        if (localStreamRef.current) {
          startLocalAudioAnalysis(localStreamRef.current)
        }
      }
    },
    [microphones, selectedMicId] // switchMicrophone は依存配列から削除
  )

  // --- スピーカー変更ハンドラ ---
  const handleSpeakerChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const newSpeakerId = event.target.value
      console.log('Selected Speaker ID:', newSpeakerId)
      setSelectedSpeakerId(newSpeakerId)

      // ★★★ 接続されている全ての audio 要素の出力先を変更 ★★★
      Object.values(audioRefs.current).forEach(async (audioElement) => {
        if (audioElement && typeof audioElement.setSinkId === 'function') {
          try {
            await audioElement.setSinkId(newSpeakerId)
            console.log(`Set sinkId for audio element to ${newSpeakerId}`)
          } catch (err) {
            console.error('Error setting sinkId:', err)
            // setSinkId が失敗した場合のエラー処理 (例: ユーザーに通知)
            alert(
              `スピーカーの切り替えに失敗しました: ${err instanceof Error ? err.message : String(err)}`
            )
          }
        } else {
          console.warn(
            'setSinkId is not supported on this audio element or browser.'
          )
          alert(
            'お使いのブラウザではスピーカーの切り替えがサポートされていません。'
          )
        }
      })
      alert(
        `スピーカーを ${speakers.find((s) => s.deviceId === newSpeakerId)?.label || '不明なデバイス'} に切り替えました (ブラウザによっては動作しない場合があります)`
      )
    },
    [speakers]
  ) // speakers を依存配列に追加

  // --- useCallback フック ---
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

  const upsertParticipant = useCallback(
    (participantData: Partial<Participant> & { id: string }) => {
      console.log('[upsertParticipant] Data:', participantData)

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
    // ★ 退出者が共有中ならリセット
    setScreenSharingPeerId((prev) => (prev === peerId ? null : prev))
  }, [])

  // ★★★ ローカル音声分析を開始する関数 ★★★
  const startLocalAudioAnalysis = useCallback(
    (stream: MediaStream) => {
      stopLocalAudioAnalysis() // 念のため既存の分析を停止

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

        source.connect(analyser) // ローカル分析では destination に接続不要

        const dataArray = new Uint8Array(analyser.frequencyBinCount)

        localAudioAnalysis.current = {
          context,
          analyser,
          source,
          animationFrameId: null,
          dataArray,
          isSpeaking: false, // 初期状態は false
        }

        const analyse = () => {
          const analysis = localAudioAnalysis.current
          if (!analysis.analyser || !analysis.dataArray) return // 安全チェック

          analysis.animationFrameId = requestAnimationFrame(analyse)
          analysis.analyser.getByteFrequencyData(analysis.dataArray)

          let sum = 0
          for (let i = 0; i < analysis.dataArray.length; i++) {
            sum += analysis.dataArray[i]
          }
          const average = sum / analysis.dataArray.length
          const isSpeaking = average > localSpeakingThreshold

          // console.log(`[CallScreen Local Analyse] Average: ${average.toFixed(2)}, IsSpeaking: ${isSpeaking}`); // デバッグ用

          if (isSpeaking !== analysis.isSpeaking) {
            analysis.isSpeaking = isSpeaking
            // ★★★ 自分自身の isSpeaking 状態を更新 ★★★
            if (myPeerIdRef.current) {
              // 自分の Peer ID が確定していれば
              console.log(
                `[CallScreen Local] Speaking status changed: ${isSpeaking}`
              )
              upsertParticipant({ id: myPeerIdRef.current, isSpeaking })
            }
          }
        }
        analyse()
        console.log('CallScreen: Started local audio analysis.')
      } catch (error) {
        console.error('CallScreen: Error starting local audio analysis:', error)
        stopLocalAudioAnalysis() // エラー時はクリーンアップ
      }
    },
    [upsertParticipant, localSpeakingThreshold]
  ) // myPeerIdRef は ref なので依存配列に不要

  // ★★★ ローカル音声分析を停止する関数 ★★★
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
    analysis.context
      ?.close()
      .catch((e) => console.error('Error closing local AudioContext:', e))

    // Ref を初期化
    localAudioAnalysis.current = {
      context: null,
      analyser: null,
      source: null,
      animationFrameId: null,
      dataArray: null,
      isSpeaking: false,
    }
    console.log('CallScreen: Stopped local audio analysis.')
    // 停止時に自分の isSpeaking を false に戻す
    if (myPeerIdRef.current) {
      upsertParticipant({ id: myPeerIdRef.current, isSpeaking: false })
    }
  }, [upsertParticipant])

  // ★★★ 画面共有切り替えハンドラ (乗っ取り方式) ★★★
  const toggleScreenShare = useCallback(async () => {
    if (isScreenSharing) {
      // --- 停止処理 ---
      try {
        await stopScreenShare()
        setIsScreenSharing(false)
        setScreenSharingPeerId(null) // 自分が停止したのでクリア
        console.log('CallScreen: Screen sharing stopped.')
      } catch (error) {
        console.error('CallScreen: Failed to stop screen share:', error)
        alert(
          `画面共有の停止に失敗しました: ${error instanceof Error ? error.message : String(error)}`
        )
        setIsScreenSharing(false) // UI 状態は停止に合わせる
        setScreenSharingPeerId(null) // 共有者もクリア
      }
    } else {
      // --- 開始処理 (他の人が共有中でも開始する) ---
      try {
        // (任意) 他の人が共有中ならコンソールにログ
        if (
          screenSharingPeerId &&
          screenSharingPeerId !== myPeerIdRef.current
        ) {
          const sharerName =
            participants.find((p) => p.id === screenSharingPeerId)?.name ||
            '他の参加者'
          console.log(`Starting screen share, taking over from ${sharerName}`)
        }

        await startScreenShare() // PeerManager の開始処理
        setIsScreenSharing(true) // 自分の共有状態を true に
        setScreenSharingPeerId(myPeerIdRef.current) // 共有者を自分に設定
        console.log('CallScreen: Screen sharing started.')
      } catch (error) {
        console.error('CallScreen: Failed to start screen share:', error)
        if (error instanceof Error && error.name !== 'NotAllowedError') {
          // ユーザーキャンセル以外
          alert(`画面共有の開始に失敗しました: ${error.message}`)
        }
        setIsScreenSharing(false) // 開始失敗
        // 失敗した場合、共有者が自分になっていたらリセット
        setScreenSharingPeerId((prev) =>
          prev === myPeerIdRef.current ? null : prev
        )
      }
    }
  }, [isScreenSharing, screenSharingPeerId, participants]) // ★ 依存配列に screenSharingPeerId, participants を追加

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
        await getDevices()

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
                // setParticipants((prev) =>
                //   prev.map((p) =>
                //     p.isSelf ? { ...p, isMuted: initialMuteState } : p
                //   )
                // )
                // ★★★ ローカルストリーム取得後に分析を開始 ★★★
                startLocalAudioAnalysis(stream)
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

            // ★★★ 画面共有状態受信コールバック (乗っ取り方式のロジック) ★★★
            onReceiveScreenShareStatus: (
              peerId: string,
              isSharing: boolean
            ) => {
              if (!isMounted) return
              console.log(
                `[CallScreen] Received screen share status from ${peerId}: ${isSharing}`
              )

              if (isSharing) {
                // --- 他の誰かが共有を開始した場合 ---
                // 現在の共有者IDを取得 (setScreenSharingPeerId は非同期なので現在の state を使う)
                const currentSharer = screenSharingPeerId // ★ state を直接参照

                // 新しい共有者が現在の共有者と違う場合
                if (currentSharer !== peerId) {
                  // もし自分が共有中だったら、ローカルで停止する
                  if (currentSharer === myPeerIdRef.current) {
                    console.warn(
                      `Peer ${peerId} started sharing, stopping local screen share.`
                    )
                    stopScreenShare().catch((err) =>
                      console.error(
                        'Error stopping local share on conflict:',
                        err
                      )
                    )
                    setIsScreenSharing(false) // 自分の共有状態も false に
                  }
                }
                // 共有者IDを新しい共有者に更新
                setScreenSharingPeerId(peerId)
              } else {
                // --- 誰かが共有を停止した場合 ---
                // 停止したのが現在の共有者であればリセット
                setScreenSharingPeerId((prev) =>
                  prev === peerId ? null : prev
                )
              }
            },
          },
          nameFromStorage!,
          isMuted
          // ★★★ 初期マイクIDを渡す (PeerManager側の対応が必要) ★★★
          // selectedMicId || undefined // selectedMicId が空文字列の場合 undefined を渡す
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
      // ★★★ ローカル分析も停止 ★★★
      stopLocalAudioAnalysis()

      // ★★★ 画面共有停止処理を追加 ★★★
      if (isScreenSharing) {
        // isScreenSharing は state なので直接参照できる
        stopScreenShare().catch((err) =>
          console.error('Cleanup: Error stopping screen share', err)
        )
      }

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
  }, [roomCode, router, removePeer, upsertParticipant, getDevices]) // 依存配列は変更なし
  // --- ここまでメインの useEffect ---

  // --- アンマウント用 useEffect (変更なし) ---
  useEffect(() => {
    return () => {
      console.log(
        'CallScreen: Component unmounting, disconnecting socket and PeerJS.'
      )
      stopLocalAudioAnalysis()
      stopScreenShare().catch((err) =>
        console.error('Unmount: Error stopping screen share', err)
      )
      socketRef.current?.disconnect()
      disconnectAll()
      initializedSocket.current = false
      socketRef.current = null
    }
  }, [stopLocalAudioAnalysis])
  // --- ここまでアンマウント用 useEffect ---

  // --- 退出処理 (変更なし) ---
  const leaveRoom = useCallback(() => {
    console.log('CallScreen: Leaving room...')
    stopScreenShare().catch((err) =>
      console.error('LeaveRoom: Error stopping screen share', err)
    )
    disconnectAll()
    socketRef.current?.disconnect()
    initializedSocket.current = false
    socketRef.current = null
    router.push('/')
  }, [router])

  // 新しい参加者追加時や初期化時にデフォルト音量を設定する処理も必要になるかも
  useEffect(() => {
    // participants が更新されたら、新しい参加者のデフォルト音量(1.0)を設定
    const newVolumes = { ...participantVolumes }
    let changed = false
    participants.forEach((p) => {
      if (!p.isSelf && !(p.id in newVolumes)) {
        newVolumes[p.id] = 1.0 // デフォルト音量
        changed = true
      }
    })
    if (changed) {
      setParticipantVolumes(newVolumes)
    }
  }, [participants, participantVolumes])

  // --- ここまで退出処理 ---

  // --- JSX レンダリング ---
  return (
    <div className={styles.container}>
      <h1>通話画面</h1>
      <p>あなたの名前: {myName}</p>
      <p>あなたのID: {myPeerId}</p>

      {/* ★★★ デバイス選択ドロップダウンを追加 ★★★ */}
      <div className={styles.deviceSelectors}>
        <div>
          <label htmlFor='mic-select'>マイク:</label>
          <select
            id='mic-select'
            value={selectedMicId}
            onChange={handleMicChange}
          >
            {microphones.map((mic) => (
              <option key={mic.deviceId} value={mic.deviceId}>
                {mic.label || `Microphone ${microphones.indexOf(mic) + 1}`}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor='speaker-select'>スピーカー:</label>
          <select
            id='speaker-select'
            value={selectedSpeakerId}
            onChange={handleSpeakerChange}
          >
            {speakers.map((speaker) => (
              <option key={speaker.deviceId} value={speaker.deviceId}>
                {speaker.label || `Speaker ${speakers.indexOf(speaker) + 1}`}
              </option>
            ))}
          </select>
        </div>
      </div>
      {/* ★★★ 共有中インジケーター (任意) ★★★ */}
      {screenSharingPeerId && (
        <div className={styles.sharingIndicator}>
          {screenSharingPeerId === myPeerIdRef.current
            ? 'あなたが画面共有中です'
            : `${participants.find((p) => p.id === screenSharingPeerId)?.name || '参加者'}が画面共有中です`}
        </div>
      )}
      <h2>参加者リスト</h2>
      <ul className={styles.participantList}>
        {participants.map((p) => {
          // 自分自身にはスライダーを表示しない
          if (p.isSelf) {
            return (
              <li
                key={p.id}
                className={`${styles.participantItem} ${styles.selfParticipant} ${
                  p.isSpeaking ? styles.speakingParticipant : '' // 自分も光るように isSpeaking を追加
                }`}
              >
                <span className={styles.participantName}>{p.name}</span>
                <span
                  className={`${styles.muteIcon} ${p.isMuted ? styles.muted : ''}`}
                >
                  {p.isMuted ? '🔇' : '🎤'}
                </span>
              </li>
            )
          }

          // 相手の音量を取得 (なければデフォルト 1.0)
          const currentVolume = participantVolumes[p.id] ?? 1.0

          return (
            <li
              key={p.id}
              className={`${styles.participantItem} ${
                p.isSpeaking ? styles.speakingParticipant : ''
              }`}
            >
              <span className={styles.participantName}>{p.name}</span>
              {/* 音量調整スライダー */}
              <input
                type='range'
                min='0'
                max='1' // max を 1 に
                step='0.01' // 細かく調整
                value={currentVolume}
                onChange={(e) =>
                  handleVolumeChange(p.id, parseFloat(e.target.value))
                }
                className={styles.volumeSlider} // CSSでスタイルを調整
                title={`音量: ${Math.round(currentVolume * 100)}%`} // ホバー時にパーセント表示
              />
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
      {/* ★★★ 画面共有ボタン (disabled 属性なし) ★★★ */}
      <button
        onClick={toggleScreenShare}
        className={`${styles.button} ${isScreenSharing ? styles.stopButton : ''}`}
        // disabled 属性は削除
      >
        {/* ★ 任意: アイコン */}
        {/* {isScreenSharing ? <StopCircleIcon width={20} height={20}/> : <ComputerDesktopIcon width={20} height={20}/>} */}
        {isScreenSharing ? '画面共有を停止' : '画面共有を開始'}
      </button>

      <button onClick={leaveRoom} className={styles.button}>
        退出
      </button>

      {/* ★★★ オーディオ要素を追加するためのコンテナ ★★★ */}
      <div id='audio-container' style={{ display: 'none' }}></div>
    </div>
  )
  // --- ここまで JSX レンダリング ---
} // ← CallScreen コンポーネントの閉じ括弧
