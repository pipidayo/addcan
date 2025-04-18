import styles from './styles.module.css'
type NameInputProps = {
  name: string
  setName: (name: string) => void
  onEnterPress: () => void //  Enterキーで実行する関数
}

export default function NameInput({
  name,
  setName,
  onEnterPress,
}: NameInputProps) {
  // ★ Enterキー処理関数
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // Enterキーが押され、かつ名前が空でない場合
    if (event.key === 'Enter' && name.trim()) {
      onEnterPress()
    }
  }

  return (
    <div className={styles.container}>
      <input
        type='text'
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder='名前を入力'
        className={styles.input}
        maxLength={16}
        onKeyDown={handleKeyDown}
      />
    </div>
  )
}
