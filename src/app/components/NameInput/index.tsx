import styles from './styles.module.css'
type Props = {
  name: string
  setName: (name: string) => void
}

export default function NameInput({ name, setName }: Props) {
  return (
    <div className={styles.container}>
      <input
        type='text'
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder='名前を入力'
        className={styles.input}
        maxLength={16}
      />
    </div>
  )
}
