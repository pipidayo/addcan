'use client'
import { useState } from 'react' // useState をインポート
import styles from './styles.module.css'
import { useRouter } from 'next/navigation'
// ★ 任意: コピーアイコンを使う場合
// import { ClipboardDocumentIcon } from '@heroicons/react/24/outline'; // 例: heroicons

type Props = {
  roomCode: string
}

export default function RoomHeader({ roomCode }: Props) {
  const router = useRouter()
  const [isCopied, setIsCopied] = useState(false) // コピー状態の state

  // "room-" プレフィックスを除いた実際のコード部分
  const displayCode = roomCode.replace('room-', '')

  // コピー処理
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(displayCode)
      setIsCopied(true)
      // 2秒後に表示を元に戻す
      setTimeout(() => setIsCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy room code: ', err)
      // エラー時のフィードバック (任意)
      alert('コピーに失敗しました。')
    }
  }

  return (
    <header className={styles.header}>
      <div className={styles.roomInfo}>
        <span className={styles.roomLabel}>部屋コード:</span>
        <div className={styles.codeContainer}>
          <span className={styles.roomCodeValue}>{displayCode}</span>
          <button
            onClick={handleCopy}
            className={styles.copyButton}
            title='部屋コードをコピー'
            disabled={isCopied} // コピー後は一時的に無効化
          >
            {/* ★ 任意: アイコンを使う場合 */}
            {/* <ClipboardDocumentIcon className={styles.copyIcon} /> */}
            {isCopied ? 'コピー完了' : 'コピー'}
          </button>
        </div>
      </div>
      {/* 退出ボタン */}
      <button onClick={() => router.push('/')} className={styles.exitButton}>
        退出する
      </button>
    </header>
  )
}
