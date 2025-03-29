'use strict'
import styles from './index.module.css'

type Props = {
  participants: string[]
}

export default function ParticipantList({ participants }: Props) {
  return (
    <div className={styles.participants}>
      <h3>参加者</h3>
      <ul>
        {participants.map((name, index) => (
          <li key={index} className={styles.participant}>
            {name}
          </li>
        ))}
      </ul>
    </div>
  )
}
