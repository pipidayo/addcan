'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import styles from './styles.module.css'

export default function TopScreen() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [roomCode, setRoomCode] = useState('')

  const createRoom = () => {
    const newRoomCode = Math.random().toString(36).substring(2, 8)

    localStorage.setItem(
      `room_${newRoomCode}`,
      JSON.stringify({ participants: [] })
    )

    router.push(`/room/${newRoomCode}`)
  }

  const joinRoom = () => {
    if (!roomCode.trim() || !name.trim()) return

    const roomData = localStorage.getItem(`room_${roomCode}`)
    if (!roomData) {
      alert('部屋が存在しません')
      return
    }

    const room = JSON.parse(roomData)
    room.participants.push(name)

    localStorage.setItem(`room_${roomCode}`, JSON.stringify(room))

    router.push(`/room/${roomCode}`)
  }

  return (
    <div className={styles.container}>
      <h1>通話アプリ</h1>
      <input
        type='text'
        placeholder='名前を入力'
        value={name}
        onChange={(e) => setName(e.target.value)}
        className={styles.input}
      />
      <button onClick={createRoom} className={styles.button}>
        部屋を作る
      </button>

      <input
        type='text'
        placeholder='コードを入力'
        value={roomCode}
        onChange={(e) => setRoomCode(e.target.value)}
        className={styles.input}
      />
      <button onClick={joinRoom} className={styles.button}>
        部屋に参加する
      </button>
    </div>
  )
}
