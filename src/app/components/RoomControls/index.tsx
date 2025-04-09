'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import styles from './styles.module.css'

type Props = {
  name: string // Home から name を受け取る
  router: ReturnType<typeof useRouter>
}

export default function RoomControls({ name, router }: Props) {
  const [roomCode, setRoomCode] = useState('')

  // 部屋を作成する処理
  const handleCreateRoom = () => {
    // ★ 名前が入力されているかチェック
    if (!name.trim()) {
      alert('名前を入力してください。')
      return // 名前がなければ処理を中断
    }
    // ★ localStorage に名前を保存
    localStorage.setItem('my_name', name)
    console.log(`Saved name to localStorage: ${name}`) // 保存を確認 (デバッグ用)

    // 新しいルームコードを生成して画面遷移
    const newRoomCode = 'room-' + Math.random().toString(36).substring(2, 8)
    router.push(`/room/${newRoomCode}`)
  }

  // 部屋に参加する処理
  const handleJoinRoom = () => {
    // ★ 名前が入力されているかチェック
    if (!name.trim()) {
      alert('名前を入力してください。')
      return // 名前がなければ処理を中断
    }
    // ★ ルームコードが入力されているかチェック
    if (!roomCode.trim()) {
      alert('ルームコードを入力してください。')
      return // ルームコードがなければ処理を中断
    }

    // ★ localStorage に名前を保存
    localStorage.setItem('my_name', name)
    console.log(`Saved name to localStorage: ${name}`) // 保存を確認 (デバッグ用)

    // TODO: (任意) 参加前に WebSocket サーバーに部屋が存在するか確認する方がより親切
    // 例えば、サーバーに問い合わせて部屋が存在しない場合はアラートを出すなど

    // 入力されたルームコードで画面遷移
    router.push(`/room/${roomCode}`)
  }

  return (
    <div className={styles.controls}>
      {/* disabled 属性はハンドラ内のチェックで代替できるため削除してもOK */}
      <button
        onClick={handleCreateRoom}
        /* disabled={!name} */ className={styles.button}
      >
        部屋を立てる
      </button>
      <input
        type='text'
        className={styles.input}
        placeholder='コードを入力'
        value={roomCode}
        onChange={(e) => setRoomCode(e.target.value)}
      />
      {/* disabled 属性はハンドラ内のチェックで代替できるため削除してもOK */}
      <button
        onClick={handleJoinRoom}
        /* disabled={!roomCode || !name} */
        className={styles.button}
      >
        部屋に入る
      </button>
    </div>
  )
}
