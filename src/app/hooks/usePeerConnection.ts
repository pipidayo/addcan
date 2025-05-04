// src/app/hooks/usePeerConnection.ts
import { useState, useEffect, useRef, useCallback } from 'react'
import { Socket } from 'socket.io-client'
import { PeerManager, type InitPeerOptions } from '../components/PeerManager'
import type { Participant } from '../type'

// --- インターフェース定義  ---
type UsePeerConnectionOptions = {
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

type UsePeerConnectionReturn = {
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
  const [isPeerOpen, setIsPeerOpen] = useState<boolean>(false)

  useEffect(() => {
    const effectInstanceId = Math.random().toString(36).substring(7)
    console.log(
      `[usePeerConnection useEffect ${effectInstanceId}] Running effect. Dependencies:`,
      {
        // 依存配列に入っている値をログに出力
        roomCode,
        myName,
        socket_connected: socket?.connected, // socket オブジェクト自体ではなく接続状態
        // 必要であれば他の依存関係も追加 (onRemoteStream などは関数なので比較が難しい)
      }
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
        if (!socket) {
          throw new Error('Socket is unexpectedly null during initialization.')
        }

        const peerOptions: InitPeerOptions = {
          roomCode: roomCode,
          socket: socket,

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
            setIsPeerOpen(true)
            // 親コンポーネント (CallScreen) に自分の参加者情報を通知/更新
            onParticipantUpdate({
              id,
              name: myName,
              isMuted: false, // 現在の isMuted state を渡す
              isSelf: true,
            })
          },

          // ★★★ サーバーへの join-room 送信は CallScreen 側で行う想定 ★★★
          // ここで join-room を送ると、myPeerId が確定する前に送られる可能性がある

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

          onRemoteScreenStreamUpdate: (stream, peerId) => {
            if (peerManagerRef.current)
              onRemoteScreenStreamUpdate(stream, peerId)
          },
          onLocalScreenStreamUpdate: (stream) => {
            console.log(
              '[usePeerConnection] Received local screen stream update from PeerManager via callback',
              stream?.id // ストリームがあればIDを出力
            )
            // Ref がクリアされていたら何もしない (念のため)
            if (!peerManagerRef.current) return
            // PeerManager から screenStream (または null) を受け取ったら State を更新
            setScreenStream(stream)
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
        setIsPeerOpen(false)
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
      setIsPeerOpen(false)
      console.log(
        `[usePeerConnection useEffect ${effectInstanceId}] Cleanup finished.`
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    // 依存配列: これらの値が変わったら再接続が必要
    roomCode,
    myName,
    socket?.connected,
  ])

  // ★★★ サーバーからの画面共有開始要求をリッスンする Effect ★★★
  useEffect(() => {
    // socket が接続され、PeerJS の準備ができたらリスナーを設定
    if (!socket || !isPeerOpen || !peerManagerRef.current) {
      // isPeerOpen が false の場合や manager がない場合は何もしない
      console.log(
        '[usePeerConnection ScreenShareListener] Skipping setup: Socket or Peer not ready.',
        { socketExists: !!socket, isPeerOpen }
      )
      return
    }

    const handleInitiateScreenShare = ({
      newPeerId,
    }: {
      newPeerId: string
    }) => {
      console.log(
        `[usePeerConnection] Received request to initiate screen share to new peer: ${newPeerId}`
      )
      const manager = peerManagerRef.current
      // 自分が現在画面共有中か確認 (PeerManager のメソッドを使う - 後で実装)
      if (manager && manager.isScreenSharing()) {
        // manager が null でないことも確認
        console.log(
          `[usePeerConnection] Currently sharing, attempting to share with ${newPeerId}`
        )
        // PeerManager の新しいメソッドを呼び出す (後で実装)
        manager
          .startScreenShareToPeer(newPeerId)
          .catch((error) =>
            console.error(
              `[usePeerConnection] Failed to start screen share to new peer ${newPeerId}:`,
              error
            )
          )
      } else {
        console.warn(
          `[usePeerConnection] Received initiate-screen-share request, but not currently sharing or manager not ready.`
        )
      }
    }

    console.log(
      '[usePeerConnection] Setting up listener for initiate-screen-share-to-new-peer'
    )
    socket.on('initiate-screen-share-to-new-peer', handleInitiateScreenShare)

    // クリーンアップ関数
    return () => {
      console.log(
        '[usePeerConnection] Cleaning up listener for initiate-screen-share-to-new-peer'
      )
      socket.off('initiate-screen-share-to-new-peer', handleInitiateScreenShare)
    }
  }, [socket, isPeerOpen]) // socket と isPeerOpen に依存

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
    if (!socket) throw new Error('Socket not connected') // socket 接続確認

    console.log(
      '[usePeerConnection] Requesting screen share permission from server...'
    )

    try {
      // サーバーに共有開始リクエストを送信し、応答を待つ (Promise 化)
      const response = await new Promise<{
        success: boolean
        message?: string
      }>((resolve) => {
        // タイムアウト処理を追加 (例: 10秒)
        const timeoutId = setTimeout(() => {
          console.error('[usePeerConnection] request-start-share timed out.')
          resolve({ success: false, message: 'Server response timed out.' })
        }, 10000) // 10秒

        socket.emit(
          'request-start-share',
          (res: { success: boolean; message?: string }) => {
            clearTimeout(timeoutId) // タイムアウトをクリア
            console.log(
              '[usePeerConnection] Received response for request-start-share:',
              res
            )
            resolve(res)
          }
        )
      })

      // サーバーから許可が得られなかった場合
      if (!response.success) {
        console.warn(
          '[usePeerConnection] Screen share denied by server:',
          response.message
        )
        // ユーザーに分かりやすいエラーメッセージを投げる
        throw new Error(response.message || '他のユーザーが画面共有中です。')
      }

      // 許可が得られたら PeerManager の共有開始処理を呼び出す
      console.log(
        '[usePeerConnection] Screen share allowed by server. Starting PeerManager share...'
      )
      await peerManagerRef.current.startScreenShare()
      console.log('[usePeerConnection] PeerManager startScreenShare finished.')
      // 成功した場合、UI 更新は onLocalScreenStreamUpdate コールバック経由で行われる
    } catch (error) {
      console.error('[usePeerConnection] Failed to start screen share:', error)
      setScreenStream(null) // エラー時は念のためクリア
      // エラーを再スローして呼び出し元 (CallScreen) で処理できるようにする
      throw error
    }
  }, [socket]) // ★ socket を依存配列に追加

  const stopScreenShare = useCallback(async () => {
    if (!peerManagerRef.current) return

    try {
      console.log(
        '[usePeerConnection] Stopping screen share via PeerManager...'
      )
      await peerManagerRef.current.stopScreenShare() // PeerManager の停止処理を先に呼ぶ
      console.log('[usePeerConnection] PeerManager stopScreenShare finished.')
    } catch (error) {
      console.error('[usePeerConnection] Failed to stop screen share:', error)
    } finally {
      // 停止時は UI の screenStream state を確実にクリア
      setScreenStream(null)
    }
  }, []) // ★ socket を依存配列に追加

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
