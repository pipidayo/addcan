;`use client`
import { useState } from 'react'
import styles from './page.module.css'
import { useRouter } from 'next/router'
import NameInput from './components/NameInput'
import RoomControls from './components/RoomControls'

export default function Home() {
  const [name, setName] = useState('')
  const router = useRouter()

  return (
    <main className={styles.container}>
      <h1 className={styles.title}>Addcan</h1>
      <NameInput name={name} setName={setName} />
      <RoomControls name={name} router={router} />
    </main>
  )
}
