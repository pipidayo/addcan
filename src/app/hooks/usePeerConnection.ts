// src/app/hooks/usePeerConnection.ts
import { useState, useEffect, useRef, useCallback } from 'react'
import { Socket } from 'socket.io-client'
// ★ PeerManager クラスと InitPeerOptions 型をインポート
import { PeerManager, type InitPeerOptions } from '../components/PeerManager'
import type { Participant } from '../components/CallScreen'

// --- インターフェース定義 (変更なし) ---
interface UsePeerConnectionOptions {
  roomCode: string | undefined
  myName: string
  socket: Socket | null
  onRemoteStream: (stream: MediaStream, peerId: string) => void
  onParticipantUpdate: (
    participantData: Partial<Participant> & { id: string }
  ) => void
  onParticipantRemove: (peerId: string) => void
  onRemoteScreenStreamUpdate: (stream: MediaStream, peerId: string) => void
}

interface UsePeerConnectionReturn {
  myPeerId: string
  localStream: MediaStream | null
  screenStream: MediaStream | null
  callPeer: (targetId: string) => Promise<void>
  sendMuteStatus: (isMuted: boolean) => void
  switchMicrophone: (deviceId: string) => Promise<void>
  startScreenShare: () => Promise<void>
  stopScreenShare: () => Promise<void>
}

export function usePeerConnection({
  roomCode,
  myName,
  socket, // socket は PeerManager 内部では使わないが、接続トリガーとして依存配列に残す
  onRemoteStream,
  onParticipantUpdate,
  onParticipantRemove,
  onRemoteScreenStreamUpdate,
}: UsePeerConnectionOptions): UsePeerConnectionReturn {
  const [myPeerId, setMyPeerId] = useState<string>('')
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null)
  // ★ PeerManager インスタンスを保持する Ref
  const peerManagerRef = useRef<PeerManager | null>(null)
  // ★ 初期化処理が進行中かを示す Ref (Strict Mode での重複実行防止)
  const initializingRef = useRef<boolean>(false)

  useEffect(() => {
    const effectInstanceId = Math.random().toString(36).substring(7)
    console.log(
      `[usePeerConnection useEffect ${effectInstanceId}] Running effect.`
    )

    // --- 初期化関数 ---
    const initialize = async () => {
      // ★ 既に初期化中、または必要な情報がなければスキップ
      if (
        initializingRef.current ||
        !roomCode ||
        !myName ||
        !socket?.connected
      ) {
        console.log(
          `[usePeerConnection useEffect ${effectInstanceId}] Skipping initialization.`,
          {
            initializing: initializingRef.current,
            roomCode,
            myName,
            socketConnected: socket?.connected,
          }
        )
        return
      }
      // ★ 初期化開始フラグ
      initializingRef.current = true
      console.log(
        `[usePeerConnection useEffect ${effectInstanceId}] Initializing...`
      )

      // ★ PeerManager インスタンス作成
      const pm = new PeerManager()
      peerManagerRef.current = pm // Ref に格納

      try {
        const peerOptions: InitPeerOptions = {
          roomCode: roomCode,

          // --- コールバックを PeerManager に渡す ---
          onRemoteStream: (stream, peerId) => {
            // ★ Ref がクリアされていたら (クリーンアップ後) 何もしない
            if (peerManagerRef.current) onRemoteStream(stream, peerId)
          },
          onLocalStream: (stream) => {
            if (!peerManagerRef.current) return
            console.log(
              `[usePeerConnection useEffect ${effectInstanceId}] Local stream obtained.`
            )
            setLocalStream(stream)
            // ミュート状態の適用は PeerManager 内部で行われる
          },
          onPeerOpen: (id) => {
            // Ref がクリアされていたら何もしない
            if (!peerManagerRef.current) return
            console.log(
              `[usePeerConnection useEffect ${effectInstanceId}] Peer opened via callback: ${id}`
            )
            setMyPeerId(id)
            // 親コンポーネント (CallScreen) に自分の参加者情報を通知/更新
            onParticipantUpdate({
              id,
              name: myName,
              isMuted: false, // 現在の isMuted state を渡す
              isSelf: true,
            })
          },

          // ★ 他のコールバックも同様に Ref チェックを追加 (より安全に)

          onReceiveUserName: (peerId, name) => {
            if (peerManagerRef.current)
              onParticipantUpdate({ id: peerId, name })
          },
          onReceiveMuteStatus: (peerId, isMutedStatus) => {
            if (peerManagerRef.current)
              onParticipantUpdate({ id: peerId, isMuted: isMutedStatus })
          },
          onPeerDisconnect: (peerId) => {
            if (peerManagerRef.current) onParticipantRemove(peerId)
          },
          onSpeakingStatusChange: (peerId, isSpeaking) => {
            if (peerManagerRef.current)
              onParticipantUpdate({ id: peerId, isSpeaking })
          },
          // onReceiveScreenShareStatus: (peerId, isSharing) => {
          //   if (peerManagerRef.current)
          //     onScreenShareStatusChange(peerId, isSharing)
          // },
          onReceiveScreenShareStatus: undefined,

          onLocalScreenStreamUpdate: (stream) => {
            console.log(
              '[usePeerConnection] Received local screen stream update from PeerManager',
              stream
            )
            // PeerManager から screenStream (または null) を受け取ったら State を更新
            setScreenStream(stream)
          },
          onRemoteScreenStreamUpdate: (stream, peerId) => {
            if (peerManagerRef.current)
              onRemoteScreenStreamUpdate(stream, peerId)
          },
        }
        console.log('[usePeerConnection useEffect] PeerManager options:', {
          onRemoteStreamExists: !!peerOptions.onRemoteStream, // peerOptions を参照
          onRemoteScreenStreamUpdateExists:
            !!peerOptions.onRemoteScreenStreamUpdate, // peerOptions を参照
          onLocalScreenStreamUpdateExists:
            !!peerOptions.onLocalScreenStreamUpdate,
        })
        // ★ インスタンスの initPeer メソッドを呼び出す
        await pm.initPeer(peerOptions, myName, false)

        // ★ 成功しても Ref がクリアされていたら (クリーンアップ後) 何もしない
        if (!peerManagerRef.current) {
          console.warn(
            `[usePeerConnection useEffect ${effectInstanceId}] Initialization successful, but cleanup already called.`
          )
          // disconnectAll はクリーンアップ関数で呼ばれるのでここでは不要
          initializingRef.current = false // フラグは戻す
          return
        }

        console.log(
          `[usePeerConnection useEffect ${effectInstanceId}] Initialization successful.`
        )
        // ★ 成功したら初期化中フラグを解除 (エラー時は finally で解除)
      } catch (error) {
        console.error(
          `[usePeerConnection useEffect ${effectInstanceId}] Initialization failed:`,
          error
        )
        // エラー発生時も Ref をクリアし、インスタンスを破棄
        peerManagerRef.current?.disconnectAll() // 念のため呼ぶ
        peerManagerRef.current = null
      } finally {
        // ★ 成功・失敗に関わらず初期化中フラグを解除
        initializingRef.current = false
      }
    }

    initialize()

    // --- クリーンアップ関数 ---
    return () => {
      console.log(
        `[usePeerConnection useEffect ${effectInstanceId}] Cleaning up...`
      )
      // ★ Ref に格納されたインスタンスの後片付けメソッドを呼ぶ
      peerManagerRef.current?.disconnectAll()
      peerManagerRef.current = null // ★ Ref をクリア
      initializingRef.current = false // ★ 初期化中フラグも念のため解除
      setMyPeerId('') // State もリセット
      setLocalStream(null) // State もリセット
      setScreenStream(null) // ★ screenStream もリセット
      console.log(
        `[usePeerConnection useEffect ${effectInstanceId}] Cleanup finished.`
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    // 依存配列: これらの値が変わったら再接続が必要
    roomCode,
    myName,
    socket,
  ])

  // --- PeerManager インスタンスのメソッドをラップ ---
  const callPeer = useCallback(async (targetId: string) => {
    console.log(`[usePeerConnection] Calling peer: ${targetId}`)
    try {
      // ★ Ref のメソッドを呼ぶ
      await peerManagerRef.current?.callPeer(targetId)
    } catch (error) {
      console.error(
        `[usePeerConnection] Error calling peer ${targetId}:`,
        error
      )
    }
  }, []) // Ref は依存配列に不要

  const sendMuteStatus = useCallback((muted: boolean) => {
    // ★ Ref のメソッドを呼ぶ
    peerManagerRef.current?.sendMuteStatus(muted)
  }, []) // Ref は依存配列に不要

  const switchMicrophone = useCallback(async (deviceId: string) => {
    console.log(`[usePeerConnection] Switching microphone to: ${deviceId}`)
    try {
      // ★ Ref のメソッドを呼ぶ
      await peerManagerRef.current?.switchMicrophone(deviceId)
    } catch (error) {
      console.error(`[usePeerConnection] Error switching microphone:`, error)
      throw error
    }
  }, []) // Ref は依存配列に不要

  const startScreenShare = useCallback(async () => {
    if (!peerManagerRef.current) throw new Error('PeerManager not initialized')
    try {
      console.log('[usePeerConnection] Starting screen share')
      await peerManagerRef.current.startScreenShare()
      // PeerManager 側で onLocalScreenStreamUpdate が呼ばれる想定
    } catch (error) {
      console.error('[usePeerConnection] Failed to start screen share:', error)
      setScreenStream(null) // エラー時は念のためクリア
      throw error
    }
  }, [])

  const stopScreenShare = useCallback(async () => {
    if (!peerManagerRef.current) return
    try {
      console.log('[usePeerConnection] Stopping screen share')
      await peerManagerRef.current.stopScreenShare()
      // PeerManager 側で onLocalScreenStreamUpdate(null) が呼ばれる想定
    } catch (error) {
      console.error('[usePeerConnection] Failed to stop screen share:', error)
    } finally {
      setScreenStream(null) // 停止時は確実にクリア
    }
  }, [])

  return {
    myPeerId,
    localStream,
    screenStream,
    callPeer,
    sendMuteStatus,
    switchMicrophone,
    startScreenShare,
    stopScreenShare,
  }
}
