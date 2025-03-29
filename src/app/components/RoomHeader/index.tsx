'use client'
import styles from './styles.module.css'
import { useRouter } from 'next/router'

type Props = {
  roomCode: string
  router: ReturnType<typeof useRouter>
}

export default function RoomHeader({ roomCode, router }: Props) {
  return
  ;<header className={styles.header}>
    <h2>部屋コード:{roomCode}</h2>
    <button onClick={() => router.push('/')} className={styles.button}>
      退出する
    </button>
  </header>
}
