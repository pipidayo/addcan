import { useState } from 'react'
import { useRouter } from 'next/navigation'
import styles from './styles.module.css'

type Props = {
  name: string
  router: ReturnType<typeof useRouter>
}

export default function RoomControls({ name, router }: Props) {
  const [roomCode, setRoomCode] = useState('')

  const createRoom = () => {
    const newRoomCode = 'room-' + Math.random().toString(36).substring(2, 8)
    router.push(`/room/${newRoomCode}`)
  }

  const joinRoom = () => {
    if (roomCode.trim()) {
      router.push(`/room/${roomCode}`)
    }
  }

  return (
    <div className={styles.controls}>
      <button onClick={createRoom} disabled={!name} className={styles.button}>
        部屋を立てる
      </button>
      <input
        type='text'
        className={styles.input}
        placeholder='コードを入力'
        value={roomCode}
        onChange={(e) => setRoomCode(e.target.value)}
      />
      <button onClick={joinRoom} disabled={!roomCode} className={styles.button}>
        部屋に入る
      </button>
    </div>
  )
}
