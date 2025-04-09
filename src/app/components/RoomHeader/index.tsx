'use client'
import styles from './styles.module.css'
import { useRouter } from 'next/navigation'

type Props = {
  roomCode: string
}

export default function RoomHeader({ roomCode }: Props) {
  const router = useRouter()

  return (
    <header className={styles.header}>
      <h2>部屋コード: {roomCode}</h2>
      {/* 退出ボタンのロジックは CallScreen の leaveRoom と重複する可能性あり */}
      <button onClick={() => router.push('/')} className={styles.button}>
        退出する
      </button>
    </header>
  )
}
