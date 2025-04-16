// src/app/components/CallControlsFooter/index.tsx
import React from 'react'
import styles from './styles.module.css'

// ★ 任意: アイコンを使う場合
// import { MicrophoneIcon, VideoCameraIcon, PhoneXMarkIcon, Cog6ToothIcon, ComputerDesktopIcon, StopCircleIcon } from '@heroicons/react/24/outline';

// Props の型定義
interface CallControlsFooterProps {
  isMuted: boolean
  isScreenSharing: boolean
  microphones: MediaDeviceInfo[]
  speakers: MediaDeviceInfo[]
  selectedMicId: string
  selectedSpeakerId: string
  localStream: MediaStream | null // ボタンの disabled 判定用
  toggleMic: () => void
  toggleScreenShare: () => void
  handleMicChange: (event: React.ChangeEvent<HTMLSelectElement>) => void
  handleSpeakerChange: (event: React.ChangeEvent<HTMLSelectElement>) => void
  leaveRoom: () => void
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
}: CallControlsFooterProps) {
  const [showDeviceSettings, setShowDeviceSettings] = React.useState(false) // デバイス設定の表示/非表示

  return (
    <div className={styles.footerContainer}>
      {/* デバイス設定エリア (ポップアップなど) */}
      {showDeviceSettings && (
        <div className={styles.deviceSettingsPopup}>
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

      {/* メインコントロールボタン */}
      <div className={styles.controls}>
        <button
          onClick={toggleMic}
          className={`${styles.controlButton} ${isMuted ? styles.mutedButton : ''}`}
          disabled={!localStream} // ローカルストリームがない場合は無効
          title={isMuted ? 'ミュート解除' : 'ミュート'}
        >
          {/* ★ アイコン例 */}
          {/* <MicrophoneIcon width={24} height={24} /> */}
          {isMuted ? '🔇' : '🎤'}
        </button>

        <button
          onClick={toggleScreenShare}
          className={`${styles.controlButton} ${isScreenSharing ? styles.stopButton : ''}`}
          title={isScreenSharing ? '画面共有を停止' : '画面共有を開始'}
        >
          {/* ★ アイコン例 */}
          {/* {isScreenSharing ? <StopCircleIcon width={24} height={24} /> : <ComputerDesktopIcon width={24} height={24} />} */}
          🖥️
        </button>

        <button
          onClick={() => setShowDeviceSettings(!showDeviceSettings)}
          className={styles.controlButton}
          title='デバイス設定'
        >
          {/* ★ アイコン例 */}
          {/* <Cog6ToothIcon width={24} height={24} /> */}
          ⚙️
        </button>

        <button
          onClick={leaveRoom}
          className={`${styles.controlButton} ${styles.leaveButton}`}
          title='退出'
        >
          {/* ★ アイコン例 */}
          {/* <PhoneXMarkIcon width={24} height={24} /> */}
          📞
        </button>
      </div>
    </div>
  )
}
