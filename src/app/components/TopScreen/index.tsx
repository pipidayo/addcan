import { useRouter } from 'next/router'
import { useState } from 'react'

export default function TopScreen() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [roomCode, setRoomCode] = useState('')

  return <div>TopScreen</div>
}
