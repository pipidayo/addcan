import styles from './styles.module.css'
import { FiAlertCircle } from 'react-icons/fi'
type NameInputProps = {
  name: string
  setName: (name: string) => void
  onEnterPress: () => void
  error: string | null // エラーメッセージを受け取る
  clearError: () => void // エラーをクリアする関数を受け取る
}

export default function NameInput({
  name,
  setName,
  onEnterPress,
  error, // Props を受け取る
  clearError, // Props を受け取る
}: NameInputProps) {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      // ★ Enter を押したらまずエラーをクリア
      clearError()
      // 名前が空でない場合のみ onEnterPress を実行 (チェックは呼び出し元でも行う)
      if (name.trim()) {
        onEnterPress()
      }
    }
  }

  return (
    <div className={styles.container}>
      <input
        type='text'
        value={name}
        onChange={(e) => {
          setName(e.target.value)
          // ★ 入力中にエラーがあればクリア
          if (error) {
            clearError()
          }
        }}
        placeholder='名前を入力'
        // ★ エラー状態に応じてスタイルを適用
        className={`${styles.input} ${error ? styles.inputError : ''}`}
        maxLength={16}
        onKeyDown={handleKeyDown}
        aria-invalid={!!error}
        // ★ aria-describedby をエラーコンテナの ID に変更
        aria-describedby={error ? 'name-input-error-container' : undefined}
      />
      {/* ★★★ エラーメッセージ表示部分を RoomControls と同じ構造に ★★★ */}
      <div
        id='name-input-error-container' // ★ ID を設定
        // ★ エラーがある場合に visible クラスを付与
        className={`${styles.errorMessageContainer} ${error ? styles.visible : ''}`}
        aria-live='polite'
      >
        {/* ★ エラーメッセージ表示 (任意) */}
        {error && (
          <>
            <FiAlertCircle className={styles.errorIcon} aria-hidden='true' />
            <p className={styles.errorMessageName}>
              {' '}
              {/* クラス名は NameInput 用のまま */}
              {error}
            </p>
          </>
        )}
      </div>
    </div>
  )
}
