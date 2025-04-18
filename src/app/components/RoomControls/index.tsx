'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import styles from './styles.module.css'
import io, { Socket } from 'socket.io-client'
import { FiClipboard, FiX, FiAlertCircle } from 'react-icons/fi'

// WebSocket サーバーの URL (CallScreen と同じもの)
const WEBSOCKET_SERVER_URL =
  process.env.NEXT_PUBLIC_WEBSOCKET_SERVER_URL || 'http://localhost:3001'

type Props = {
  name: string // Home から name を受け取る
  router: ReturnType<typeof useRouter>
  registerActions: (actions: { createRoom?: () => void }) => void
}

export default function RoomControls({ name, router, registerActions }: Props) {
  const [roomCodeInput, setRoomCodeInput] = useState('')
  const [isCheckingRoom, setIsCheckingRoom] = useState(false) // 確認中フラグを追加
  const [isInputFocused, setIsInputFocused] = useState(false) // ★ フォーカス状態
  const [isInputHovered, setIsInputHovered] = useState(false) // ★ ホバー状態
  const inputRef = useRef<HTMLInputElement>(null) // ★ input 要素への参照
  const [roomCodeError, setRoomCodeError] = useState<string | null>(null)
  const [errorTimeoutId, setErrorTimeoutId] = useState<NodeJS.Timeout | null>(
    null
  )
  // ★ 部屋を作成する処理 (useCallback でメモ化)
  const handleCreateRoom = useCallback(() => {
    if (!name.trim()) {
      alert('名前を入力してください。')
      return
    }
    // ★ localStorage に名前を保存
    localStorage.setItem('my_name', name)
    console.log(`Saved name to localStorage: ${name}`) // 保存を確認 (デバッグ用)

    // 新しいルームコードを生成して画面遷移
    const newRoomCode = 'room-' + Math.random().toString(36).substring(2, 8)
    router.push(`/room/${newRoomCode}`)
  }, [name, router]) // ★ name と router に依存

  // ★ ペースト処理
  const handlePaste = async () => {
    if (isCheckingRoom) return // 確認中はペーストしない
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        // ★ 貼り付ける前にトリムして最初の6文字を取得
        const pastedText = text.trim().substring(0, 6)
        setRoomCodeInput(pastedText)
        inputRef.current?.focus()
      }
    } catch (err) {
      console.error('クリップボードからの読み取りに失敗:', err)
      // ユーザーにエラーを通知 (alert よりトースト通知などが望ましい場合も)
      alert(
        'クリップボードからの貼り付けに失敗しました。\nブラウザの設定でクリップボードへのアクセスが許可されているか確認してください。'
      )
    }
  }
  // ★ エラーメッセージ表示と自動非表示タイマー設定のヘルパー関数
  const showError = (message: string, duration: number = 4000) => {
    // 4秒後に消える設定
    // 既存のタイマーがあればクリア
    if (errorTimeoutId) {
      clearTimeout(errorTimeoutId)
    }
    setRoomCodeError(message)
    // 新しいタイマーを設定
    const newTimeoutId = setTimeout(() => {
      setRoomCodeError(null)
      setErrorTimeoutId(null)
    }, duration)
    setErrorTimeoutId(newTimeoutId)
  }

  // ★ エラーとタイマーをクリアするヘルパー関数
  const clearError = () => {
    if (roomCodeError) {
      // エラーがある場合のみ処理
      if (errorTimeoutId) {
        clearTimeout(errorTimeoutId)
        setErrorTimeoutId(null)
      }
      setRoomCodeError(null)
    }
  }

  // ★ クリア処理
  const handleClear = () => {
    if (isCheckingRoom) return // 確認中はクリアしない
    setRoomCodeInput('')
    // クリア後に入力欄にフォーカスを戻す (任意)
    inputRef.current?.focus()
  }

  // 部屋に参加する処理 (async に変更し、WebSocket 確認処理を追加)
  const handleJoinRoom = async () => {
    clearError()
    setRoomCodeError(null) // ★ 最初にエラーをクリア
    // 名前とルームコードのチェック (変更なし)
    if (!name.trim()) {
      alert('名前を入力してください。')
      return
    }
    const shortCode = roomCodeInput.trim()
    if (!shortCode) {
      showError('ルームコードを入力してください。')
      return
    }

    // 内部処理用に "room-" プレフィックスを付与
    const fullRoomCode = `room-${shortCode}`

    // 確認中フラグを立てる (ボタンを無効化するため)
    setIsCheckingRoom(true)

    let socket: Socket | null = null // socket 変数を宣言
    try {
      // 一時的に WebSocket 接続を作成
      socket = io(WEBSOCKET_SERVER_URL, {
        reconnection: false, // 自動再接続は不要
        timeout: 5000, // 5秒でタイムアウト
      })

      // 接続成功またはエラーを待つ (Promise 化)
      await new Promise<void>((resolve, reject) => {
        socket!.once('connect', resolve)
        socket!.once('connect_error', (err) => {
          console.error('Temporary socket connection error:', err)
          reject(new Error('サーバー接続エラー')) // エラーメッセージを具体的に
        })
        // タイムアウト処理 (connect_error が発火しない場合もあるため)
        const timer = setTimeout(
          () => reject(new Error('サーバー接続タイムアウト')),
          5000
        )
        socket!.once('connect', () => clearTimeout(timer)) // 接続成功したらタイマー解除
      })

      console.log(
        '[RoomControls] Temporarily connected to WebSocket for room check.'
      )

      // サーバーに部屋の存在確認をリクエスト (Promise 化)
      const result = await new Promise<{ exists: boolean }>(
        (resolve, reject) => {
          socket!.emit(
            'check-room-exists',
            { roomCode: fullRoomCode },
            (response: { exists: boolean } | null) => {
              // コールバックが想定通り呼ばれたかチェック
              if (response && typeof response.exists === 'boolean') {
                resolve(response)
              } else {
                // サーバーからの応答がない、または形式が違う場合
                reject(new Error('サーバーからの応答が不正です。'))
              }
            }
          )
          // emit に対する応答タイムアウト
          setTimeout(() => reject(new Error('部屋確認タイムアウト')), 5000)
          // コールバックが呼ばれたらタイマー解除 (socket.io v3以降ではackは一度しか呼ばれない)
          // socket.io v3+ では ack は Promise を返すので、本来はそちらを使うのがモダン
          // socket.emitWithAck('check-room-exists', { roomCode: codeToJoin }).then(resolve).catch(reject);
          // 今回は callback 形式で実装
          // ※ ack が呼ばれたことを確実に検知する方法が標準APIにはないため、
          //   ここでは emitTimer の解除は省略し、エラー時の reject に任せる。
        }
      )

      console.log(
        `[RoomControls] Room ${fullRoomCode} exists check result:`,
        result.exists
      )

      if (result.exists) {
        // 部屋が存在する場合のみ localStorage に保存して画面遷移
        localStorage.setItem('my_name', name)
        console.log(`Saved name to localStorage: ${name}`)
        router.push(`/room/${fullRoomCode}`)
        // 遷移成功時は setIsCheckingRoom(false) は不要 (画面が変わるため)
      } else {
        // 部屋が存在しない場合
        showError(`コードが間違っています`)
        setIsCheckingRoom(false) // 確認完了、ボタンを有効化
      }
    } catch (error: unknown) {
      // any を unknown に変更
      console.error('Error checking room existence:', error)
      // ★★★ error が Error インスタンスか確認 ★★★
      let errorMessage = '不明なエラー'
      if (error instanceof Error) {
        errorMessage = error.message
      }
      showError(`確認失敗: ${errorMessage}`)
      setIsCheckingRoom(false)
    } finally {
      // 確認が終わったら必ず切断
      if (socket) {
        console.log('[RoomControls] Disconnecting temporary WebSocket.')
        socket.disconnect()
      }
    }
  }

  // ★ useEffect を使って親コンポーネントに関数を登録
  useEffect(() => {
    // createRoom アクションとして handleCreateRoom を登録
    registerActions({ createRoom: handleCreateRoom })
    // クリーンアップ: コンポーネントがアンマウントされたら登録解除 (任意)
    return () => {
      registerActions({})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerActions, handleCreateRoom]) // ★ registerActions と handleCreateRoom に依存

  // ★ コンポーネントアンマウント時にタイマーをクリアする useEffect
  useEffect(() => {
    return () => {
      if (errorTimeoutId) {
        clearTimeout(errorTimeoutId)
      }
    }
  }, [errorTimeoutId])

  // アイコン表示条件 (変更なし)
  const canShowPaste = !isCheckingRoom
  const canShowClear = roomCodeInput.length > 0 && !isCheckingRoom

  return (
    <div className={styles.controls}>
      {/* disabled 属性はハンドラ内のチェックで代替できるため削除してもOK */}
      <button
        onClick={handleCreateRoom}
        disabled={isCheckingRoom} // 確認中は無効化
        className={styles.button}
      >
        部屋を立てる
      </button>
      {/* --- 入力欄とアイコンのコンテナ --- */}
      <div
        className={styles.inputContainer} // 新しいスタイルクラス
        onMouseEnter={() => setIsInputHovered(true)}
        onMouseLeave={() => setIsInputHovered(false)}
      >
        <input
          ref={inputRef}
          type='text'
          className={`${styles.input} ${
            roomCodeError ? styles.inputError : ''
          }`}
          placeholder='コードを入力'
          value={roomCodeInput}
          onChange={(e) => {
            setRoomCodeInput(e.target.value)
            if (roomCodeError) {
              // ★ エラーがあればクリア
              clearError()
            }
          }}
          onFocus={() => setIsInputFocused(true)}
          onBlur={() => setIsInputFocused(false)}
          disabled={isCheckingRoom} // 確認中は無効化
          onKeyDown={(e) => {
            if (e.key === 'Enter' && roomCodeInput.trim() && name.trim()) {
              handleJoinRoom()
            }
          }}
          maxLength={6}
          aria-invalid={!!roomCodeError}
          aria-describedby={roomCodeError ? 'room-code-error' : undefined}
        />

        {/* ★ エラーメッセージ表示エリア */}
        <div className={styles.errorMessageContainer} aria-live='polite'>
          {' '}
          {/* aria-live を追加 */}
          {roomCodeError && (
            <>
              {' '}
              {/* Fragment を使用 */}
              <FiAlertCircle
                className={styles.errorIcon}
                aria-hidden='true'
              />{' '}
              {/* アイコンを追加 */}
              <p id='room-code-error' className={styles.errorMessage}>
                {' '}
                {/* id を追加 */}
                {roomCodeError}
              </p>
            </>
          )}
        </div>

        {/* --- アイコン表示エリア --- */}
        <div className={styles.inputIcons}>
          {/* クリアアイコン (入力があり、確認中でない場合) */}
          {canShowClear && (isInputFocused || isInputHovered) && (
            <button
              type='button' // form の submit を防ぐ
              onClick={handleClear}
              className={`${styles.iconButton} ${styles.clearIcon}`}
              title='入力をクリア'
              aria-label='入力をクリア'
              tabIndex={-1} // Tab キーでのフォーカス対象外にする (任意)
            >
              <FiX />
            </button>
          )}
          {/* ペーストアイコン (フォーカス or ホバー中で、確認中でない場合) */}
          {canShowPaste && (
            <button
              type='button'
              onClick={handlePaste}
              className={`${styles.iconButton} ${styles.pasteIcon}`}
              title='クリップボードからペースト'
              aria-label='クリップボードからペースト'
              tabIndex={-1} // Tab キーでのフォーカス対象外にする (任意)
            >
              <FiClipboard />
            </button>
          )}
        </div>
      </div>

      <button
        onClick={handleJoinRoom}
        disabled={isCheckingRoom || !roomCodeInput.trim() || !name.trim()} // 確認中や未入力時も無効化
        className={styles.button}
      >
        {isCheckingRoom ? '確認中...' : '部屋に入る'} {/* ボタン表示切替 */}
      </button>
    </div>
  )
}
