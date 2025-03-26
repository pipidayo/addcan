import styles from './styles.module.css'
type Props = {
  name: string
  setName: (name: string) => void
}

export default function NameInput({ name, setName }: Props) {
  return (
    <input
      type='text'
      value={name}
      onChange={(e) => setName(e.target.value)}
      placeholder='名前を入力'
      className={styles.input}
    />
  )
}
