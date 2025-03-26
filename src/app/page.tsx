import { useState } from 'react'
import styles from './page.module.css'
import { useRouter } from 'next/router'

export default function Home() {
  const [name, setName] = useState('')
  const router = useRouter()

  return <div></div>
}
