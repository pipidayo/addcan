'use client'
import { useParams } from 'next/navigation'
import CallScreen from '@/app/components/CallScreen'
import styles from './styles.module.css'

export default function RoomPage() {
  const { room: roomCodeParam } = useParams() // roomCode の取得方法を CallScreen に合わせる
  const roomCode = Array.isArray(roomCodeParam)
    ? roomCodeParam[0]
    : roomCodeParam

  // const router = useRouter()

  // roomCode が取得できていない場合は早期リターンまたはエラー表示
  if (!roomCode) {
    // 例えばローディング表示やエラーメッセージを表示
    return <div>ルームコードを読み込み中... または無効なルームです。</div>
  }

  return (
    <div className={styles.container}>
      <CallScreen /> {/* ★ CallScreen を使用 (props は不要) */}
    </div>
  )
}
