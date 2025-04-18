'use client'
import { useState, useRef, useCallback } from 'react'
import styles from './page.module.css'
import { useRouter } from 'next/navigation'
import NameInput from './components/NameInput'
import RoomControls from './components/RoomControls'

export default function Home() {
  const [name, setName] = useState('')
  const router = useRouter()

  // ★ RoomControls のアクションを保持するための Ref
  const roomControlsActions = useRef<{ createRoom?: () => void }>({})

  // ★ NameInput から Enter で呼び出される関数
  const triggerEnterAction = useCallback(() => {
    // 名前が入力されているかチェック
    if (!name.trim()) {
      alert('名前を入力してください。')
      return
    }
    // RoomControls の createRoom アクションを実行
    console.log('Enter pressed in NameInput, triggering createRoom...')
    roomControlsActions.current?.createRoom?.()
  }, [name]) // ★ name に依存

  return (
    <main className={styles.container}>
      <h1 className={styles.title}>Addcan</h1>
      <NameInput
        name={name}
        setName={setName}
        onEnterPress={triggerEnterAction}
      />
      <RoomControls
        name={name}
        router={router}
        registerActions={(actions) => {
          // RoomControls から渡されたアクションを Ref に保存
          roomControlsActions.current = actions
        }}
      />
    </main>
  )
}
