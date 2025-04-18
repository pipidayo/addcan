// src/app/components/CallControlsFooter/index.tsx
import React, { useMemo, useCallback, useState } from 'react'
import styles from './styles.module.css'
import type { Participant } from '../CallScreen'

// Props の型定義
interface CallControlsFooterProps {
  isMuted: boolean
  isScreenSharing: boolean
  microphones: MediaDeviceInfo[]
  speakers: MediaDeviceInfo[]
  selectedMicId: string
  selectedSpeakerId: string
  localStream: MediaStream | null
  toggleMic: () => void
  toggleScreenShare: () => void
  handleMicChange: (event: React.ChangeEvent<HTMLSelectElement>) => void
  handleSpeakerChange: (event: React.ChangeEvent<HTMLSelectElement>) => void
  leaveRoom: () => void
  myPeerId: string
  participants: Participant[]
  screenSharingPeerId: string | null
  roomCode: string | undefined
}

export default function CallControlsFooter({
  isMuted,
  isScreenSharing,
  microphones,
  speakers,
  selectedMicId,
  selectedSpeakerId,
  localStream,
  toggleMic,
  toggleScreenShare,
  handleMicChange,
  handleSpeakerChange,
  leaveRoom,
  screenSharingPeerId,
  myPeerId,
  participants,
  roomCode,
}: CallControlsFooterProps) {
  const [showDeviceSettings, setShowDeviceSettings] = useState(false)
  const [isCopied, setIsCopied] = useState(false) // コピー完了状態
  const displayCode = useMemo(() => roomCode?.replace('room-', ''), [roomCode])

  console.log('[CallControlsFooter] Received Props:', {
    screenSharingPeerId,
    myPeerId,
  })

  const sharingParticipantName = useMemo(() => {
    if (!screenSharingPeerId) return null
    if (screenSharingPeerId === myPeerId) return 'あなた'
    return (
      participants.find((p) => p.id === screenSharingPeerId)?.name || '参加者'
    )
  }, [screenSharingPeerId, myPeerId, participants])

  // ★ コピー処理 (波紋ロジックは削除)
  const handleCopyCode = useCallback(() => {
    if (!displayCode || isCopied) return

    const textToCopy = displayCode // ラベルも含めてコピー
    navigator.clipboard
      .writeText(textToCopy)
      .then(() => {
        console.log('Text copied to clipboard:', textToCopy)
        setIsCopied(true) // 吹き出し表示開始
        setTimeout(() => {
          setIsCopied(false) // 吹き出し非表示
        }, 1500) // 吹き出し表示時間
      })
      .catch((err) => {
        console.error('Failed to copy text:', err)
        alert('テキストのコピーに失敗しました。')
      })
  }, [displayCode, isCopied])

  return (
    <div className={styles.footerContainer}>
      {/* デバイス設定エリア */}
      {showDeviceSettings && (
        <div className={styles.deviceSettingsPopup}>
          {/* ... (中身は変更なし) ... */}
          <div className={styles.deviceSelector}>
            <label htmlFor='mic-select-footer'>マイク:</label>
            <select
              id='mic-select-footer'
              value={selectedMicId}
              onChange={handleMicChange}
              disabled={microphones.length === 0}
            >
              {microphones.map((mic) => (
                <option key={mic.deviceId} value={mic.deviceId}>
                  {mic.label || `Microphone ${microphones.indexOf(mic) + 1}`}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.deviceSelector}>
            <label htmlFor='speaker-select-footer'>スピーカー:</label>
            <select
              id='speaker-select-footer'
              value={selectedSpeakerId}
              onChange={handleSpeakerChange}
              disabled={speakers.length === 0}
            >
              {speakers.map((speaker) => (
                <option key={speaker.deviceId} value={speaker.deviceId}>
                  {speaker.label || `Speaker ${speakers.indexOf(speaker) + 1}`}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={() => setShowDeviceSettings(false)}
            className={styles.closeButton}
          >
            閉じる
          </button>
        </div>
      )}

      {/* メインコントロール */}
      <div className={styles.controls}>
        {/* ルームコード表示＆コピー */}
        {displayCode && (
          // ↓↓↓ 位置決めの基準となるコンテナ ↓↓↓
          <div className={styles.roomCodeContainerFooter}>
            <span className={styles.roomLabelFooter}>部屋コード:</span>
            <div
              className={styles.roomCodeFooter} // ★ .copied クラスは不要
              onClick={handleCopyCode}
              title={'クリックしてルームコードをコピー'}
            >
              <span className={styles.roomCodeValueFooter}>
                {/* 表示はずっとコード本体 */}
                {displayCode}
              </span>
              <div
                className={`${styles.copyTooltip} ${isCopied ? styles.visible : ''}`}
              >
                コピー完了！
              </div>
            </div>
          </div>
        )}

        {/* 画面共有インジケーター */}
        {sharingParticipantName && (
          <div className={styles.footerSharingIndicator}>
            {sharingParticipantName}が画面共有中
          </div>
        )}

        {/* 各種コントロールボタン */}
        <button
          onClick={toggleMic}
          className={`${styles.controlButton} ${isMuted ? styles.mutedButton : ''}`}
          disabled={!localStream}
          title={isMuted ? 'ミュート解除' : 'ミュート'}
        >
          {isMuted ? '🔇' : '🎤'}
        </button>
        <button
          onClick={toggleScreenShare}
          className={`${styles.controlButton} ${isScreenSharing ? styles.stopButton : ''}`}
          title={isScreenSharing ? '画面共有を停止' : '画面共有を開始'}
        >
          🖥️
        </button>
        <button
          onClick={() => setShowDeviceSettings(!showDeviceSettings)}
          className={styles.controlButton}
          title='デバイス設定'
        >
          ⚙️
        </button>
        <button
          onClick={leaveRoom}
          className={`${styles.controlButton} ${styles.leaveButton}`}
          title='退出'
        >
          📞
        </button>
      </div>
    </div>
  )
}
