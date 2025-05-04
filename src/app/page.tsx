'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import styles from './page.module.css'
import { useRouter } from 'next/navigation'
import NameInput from './components/NameInput'
import RoomControls from './components/RoomControls'

type RoomControlActions = {
  createRoom?: () => void
  handleNameInputEnter?: () => void // ★ 追加
}

export default function Home() {
  const [name, setName] = useState('')
  const router = useRouter()
  // ★ RoomControls のアクションを保持するための Ref
  const roomControlsActions = useRef<RoomControlActions>({})

  // ★★★ エラー状態管理を page.tsx に移動 ★★★
  const [error, setError] = useState<{
    message: string | null
    target: 'name' | 'roomCode' | null
  }>({ message: null, target: null })
  const [errorTimeoutId, setErrorTimeoutId] = useState<NodeJS.Timeout | null>(
    null
  )

  // ★ エラー表示関数
  const showError = useCallback(
    (message: string, target: 'name' | 'roomCode', duration: number = 2500) => {
      // ★ duration を短く (例: 2500ms)
      if (errorTimeoutId) {
        clearTimeout(errorTimeoutId)
      }
      setError({ message, target })
      const newTimeoutId = setTimeout(() => {
        setError({ message: null, target: null })
        setErrorTimeoutId(null)
      }, duration)
      setErrorTimeoutId(newTimeoutId)
    },
    [errorTimeoutId]
  ) // errorTimeoutId に依存

  // ★ エラー解除関数
  const clearError = useCallback(() => {
    if (error.message) {
      // エラーがある場合のみ処理
      if (errorTimeoutId) {
        clearTimeout(errorTimeoutId)
        setErrorTimeoutId(null)
      }
      setError({ message: null, target: null })
    }
  }, [error.message, errorTimeoutId]) // error.message と errorTimeoutId に依存

  // ★ コンポーネントアンマウント時にタイマーをクリア
  useEffect(() => {
    return () => {
      if (errorTimeoutId) {
        clearTimeout(errorTimeoutId)
      }
    }
  }, [errorTimeoutId])

  // ★ NameInput から Enter で呼び出される関数
  const triggerEnterAction = useCallback(() => {
    // ★ Enter時にもエラーをクリア
    clearError()
    console.log(
      'Enter pressed in NameInput, triggering handleNameInputEnter...'
    )
    roomControlsActions.current?.handleNameInputEnter?.()
  }, [clearError]) // ★ clearError を依存配列に追加

  return (
    <main className={styles.container}>
      <h1 className={styles.title}>Addcan</h1>
      <NameInput
        name={name}
        setName={(newName) => {
          setName(newName)
          // ★ 名前入力時にもエラーをクリア
          if (error.target === 'name') {
            clearError()
          }
        }}
        onEnterPress={triggerEnterAction}
        // ★ NameInput にエラー情報とクリア関数を渡す
        error={error.target === 'name' ? error.message : null}
        clearError={clearError}
      />
      <RoomControls
        name={name}
        router={router}
        registerActions={(actions) => {
          roomControlsActions.current = actions
        }}
        // ★ RoomControls にエラー情報と操作関数を渡す
        error={error.target === 'roomCode' ? error.message : null}
        showError={showError}
        clearError={clearError}
      />
    </main>
  )
}
