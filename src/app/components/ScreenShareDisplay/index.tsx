// src/app/components/ScreenShareDisplay/index.tsx
import React from 'react'
import styles from './styles.module.css'

type ScreenShareDisplayProps = {
  screenSharingPeerId: string | null // 現在画面共有中の人の Peer ID
  myPeerId: string // 自分の Peer ID
  localScreenStream: MediaStream | null // 自分の画面共有ストリーム (プレビュー用)
  remoteScreenStream: MediaStream | null // 他の人の画面共有ストリーム
  screenVideoRef: React.RefObject<HTMLVideoElement | null> // リモート画面用 <video> 要素の Ref
  localScreenPreviewRef: React.RefObject<HTMLVideoElement | null> // ローカルプレビュー用 <video> 要素の Ref
}

export default function ScreenShareDisplay({
  screenSharingPeerId,
  myPeerId,
  localScreenStream,
  remoteScreenStream,
  screenVideoRef,
  localScreenPreviewRef,
}: ScreenShareDisplayProps) {
  const isScreenSharingMyself =
    screenSharingPeerId === myPeerId && myPeerId !== ''

  return (
    // ★ screenShareArea クラスを適用
    <div className={styles.screenShareArea}>
      {(() => {
        // ★ Props を使用するように変更
        if (isScreenSharingMyself && localScreenStream) {
          return (
            <video
              // ★ Props の Ref を使用
              ref={localScreenPreviewRef}
              // ★ CSS Module を適用
              className={styles.localScreenPreview}
              autoPlay
              playsInline
              muted // 自分のプレビューはミュート
            />
          )
        } else if (
          screenSharingPeerId && // 誰かが共有中
          !isScreenSharingMyself && // 自分ではない
          remoteScreenStream // リモートストリームがある
        ) {
          return (
            <video
              // ★ Props の Ref を使用
              ref={screenVideoRef}
              // ★ CSS Module を適用
              className={styles.screenVideo}
              autoPlay
              playsInline
              // リモート画面の音量は CallControlsFooter で制御するので muted は不要
            />
          )
        } else if (
          screenSharingPeerId && // 誰かが共有中
          !isScreenSharingMyself && // 自分ではない
          !remoteScreenStream // まだリモートストリームがない
        ) {
          return (
            // ★ CSS Module を適用
            <div className={styles.loadingScreenShare}>画面を読み込み中...</div>
          )
        } else {
          // 誰も共有していない
          return (
            // ★ CSS Module を適用
            <div className={styles.noScreenShare}>画面共有はされていません</div>
          )
        }
      })()}
    </div>
  )
}
