// src/app/hooks/useWebSocket.ts
import { useState, useEffect, useRef, useCallback } from 'react'
import io, { Socket } from 'socket.io-client'
import { useRouter } from 'next/navigation' // エラー時のリダイレクト用にインポート

// WebSocket サーバーの URL
const WEBSOCKET_SERVER_URL =
  process.env.NEXT_PUBLIC_WEBSOCKET_SERVER_URL || 'http://localhost:3001'

// --- 型定義
import type {
  RoomStatePayload,
  UserJoinedPayload,
  ScreenShareStatusPayload,
  JoinRoomPayload,
  DisconnectReason, // Socket.DisconnectReason のエイリアスをインポート
} from '../type' // 仮のパス

// --- ここまで型定義 ---

// --- フックの Props の型定義 ---
type UseWebSocketProps = {
  roomCode: string | undefined
  // イベントハンドラーを Props として受け取る
  onRoomState: (payload: RoomStatePayload) => void
  onUserJoined: (payload: UserJoinedPayload) => void
  onUserLeft: (peerId: string) => void
  onScreenShareStatus: (payload: ScreenShareStatusPayload) => void
  // エラー時の処理も Props で受け取る (オプション)
  onConnectError?: (error: Error) => void
  onDisconnect?: (reason: DisconnectReason) => void
}

// --- フックの戻り値の型定義 ---
interface UseWebSocketReturn {
  socketInstance: Socket | null
  emitJoinRoom: (peerId: string, name: string) => void // join-room を emit する関数
}

export function useWebSocket({
  roomCode,
  onRoomState,
  onUserJoined,
  onUserLeft,
  onScreenShareStatus,
  onConnectError,
  onDisconnect,
}: UseWebSocketProps): UseWebSocketReturn {
  const socketRef = useRef<Socket | null>(null)
  const [socketInstance, setSocketInstance] = useState<Socket | null>(null)

  // ★ コールバック関数を保持するための Ref を追加
  const onConnectErrorRef = useRef(onConnectError)
  const onDisconnectRef = useRef(onDisconnect)
  const onRoomStateRef = useRef(onRoomState)
  const onUserJoinedRef = useRef(onUserJoined)
  const onUserLeftRef = useRef(onUserLeft)
  const onScreenShareStatusRef = useRef(onScreenShareStatus)

  // ★ Props の関数が変わったら Ref を更新する Effect を追加
  useEffect(() => {
    onConnectErrorRef.current = onConnectError
  }, [onConnectError])

  useEffect(() => {
    onDisconnectRef.current = onDisconnect
  }, [onDisconnect])

  useEffect(() => {
    onRoomStateRef.current = onRoomState
  }, [onRoomState])
  useEffect(() => {
    onUserJoinedRef.current = onUserJoined
  }, [onUserJoined])
  useEffect(() => {
    onUserLeftRef.current = onUserLeft
  }, [onUserLeft])
  useEffect(() => {
    onScreenShareStatusRef.current = onScreenShareStatus
  }, [onScreenShareStatus])

  // --- WebSocket 接続 Effect (CallScreen から移動) ---
  useEffect(() => {
    console.log('[useWebSocket Connection useEffect] Initializing...')
    if (!roomCode) {
      console.error('[useWebSocket] Room code is missing.')
      // router.push('/'); // フック内で直接リダイレクトするかは要検討 (エラーを返す方が良いかも)
      return
    }

    // マウント状態を追跡するフラグ (Strict Mode対策)
    const isMounted = { current: true }

    // 既に接続試行中または接続済みなら何もしない
    if (socketRef.current) {
      // 接続済みで state に反映されていなければ反映
      if (socketRef.current.connected && !socketInstance) {
        setSocketInstance(socketRef.current)
      }
      return
    }

    console.log('[useWebSocket] Initializing WebSocket connection...')
    const socket = io(WEBSOCKET_SERVER_URL)
    socketRef.current = socket // Ref に保持

    socket.on('connect', () => {
      console.log(
        '★★★ [useWebSocket] WebSocket connected! Socket ID:',
        socket.id
      )
      if (isMounted.current) {
        setSocketInstance(socket) // State を更新して外部に通知
      }
    })

    socket.on('connect_error', (error) => {
      console.error('[useWebSocket] WebSocket connection error:', error)
      socketRef.current = null // Ref をクリア
      if (isMounted.current) {
        setSocketInstance(null) // State をクリア
      }
      // ↓↓↓ Ref 経由でコールバックを呼び出す ↓↓↓
      onConnectErrorRef.current?.(error)
      // alert('サーバーとの接続に失敗しました。'); // フック内での alert は避ける
    })

    socket.on('disconnect', (reason) => {
      console.log('[useWebSocket] WebSocket disconnected:', reason)
      if (isMounted.current) {
        setSocketInstance(null) // State をクリア
      }
      // ↓↓↓ Ref 経由でコールバックを呼び出す ↓↓↓
      onDisconnectRef.current?.(reason)
      socketRef.current = null
    })

    // クリーンアップ関数
    return () => {
      isMounted.current = false // アンマウント状態に
      console.log('[useWebSocket Connection useEffect] Cleaning up...')
      // ★ アンマウント時に切断処理を追加
      if (socketRef.current) {
        console.log('[useWebSocket] Disconnecting socket on cleanup.')
        socketRef.current.disconnect()
        socketRef.current = null
      }
    }
    // roomCode が変わったら再接続、router は通常変わらないが念のため
    // socketInstance はこの Effect 内で設定するので依存配列に含めない
  }, [roomCode])

  // --- WebSocket イベントリスナー Effect (CallScreen から移動) ---
  useEffect(() => {
    // socketInstance がなければリスナーを設定しない
    if (!socketInstance) return

    console.log('[useWebSocket Listeners useEffect] Setting up...')

    // ↓↓↓ Ref 経由でコールバックを呼び出すラッパー関数を定義 ↓↓↓
    const handleRoomState = (payload: RoomStatePayload) =>
      onRoomStateRef.current?.(payload)
    const handleUserJoined = (payload: UserJoinedPayload) =>
      onUserJoinedRef.current?.(payload)
    const handleUserLeft = (peerId: string) => onUserLeftRef.current?.(peerId)
    const handleScreenShareStatus = (payload: ScreenShareStatusPayload) =>
      onScreenShareStatusRef.current?.(payload)

    // ラッパー関数をリスナーとして登録
    socketInstance.on('room-state', handleRoomState)
    socketInstance.on('user-joined', handleUserJoined)
    socketInstance.on('user-left', handleUserLeft)
    socketInstance.on('screen-share-status', handleScreenShareStatus)

    return () => {
      console.log('[useWebSocket Listeners useEffect] Cleaning up...')
      // ラッパー関数を解除
      socketInstance.off('room-state', handleRoomState)
      socketInstance.off('user-joined', handleUserJoined)
      socketInstance.off('user-left', handleUserLeft)
      socketInstance.off('screen-share-status', handleScreenShareStatus)
    }
    // ↓↓↓ 依存配列を socketInstance のみに変更 ↓↓↓
  }, [socketInstance]) // ★ socketInstance のみに依存

  // --- join-room を emit する関数 ---
  const emitJoinRoom = useCallback(
    (peerId: string, name: string) => {
      if (socketInstance && roomCode && peerId && name) {
        console.log(`[useWebSocket] Emitting join-room with peerId: ${peerId}`)
        const joinPayload: JoinRoomPayload = {
          // JoinRoomPayload 型をインポートしておく
          roomCode,
          peerId,
          name,
        }
        socketInstance.emit('join-room', joinPayload)
      } else {
        console.warn('[useWebSocket] Cannot emit join-room. Missing data.', {
          socketConnected: !!socketInstance,
          roomCode,
          peerId,
          name,
        })
      }
    },
    [socketInstance, roomCode]
  ) // ★ socketInstance と roomCode に依存

  return { socketInstance, emitJoinRoom }
}
