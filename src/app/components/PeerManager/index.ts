// src/app/components/PeerManager/index.ts
import Peer, { MediaConnection, DataConnection, PeerJSOption } from 'peerjs'

// --- インターフェースと型定義 ---
type Message =
  | { type: 'USER_NAME'; payload: string }
  | { type: 'MUTE_STATUS'; payload: boolean }
  | { type: 'SCREEN_SHARE_STATUS'; payload: boolean }

export type InitPeerOptions = {
  roomCode: string // roomCode は PeerManager 内部では直接使わないかも
  onReceiveStream: (stream: MediaStream, peerId: string) => void
  onReceiveScreenStream: (stream: MediaStream, peerId: string) => void
  onPeerOpen: (id: string) => void
  onLocalStream: (stream: MediaStream) => void
  onReceiveUserName: (peerId: string, name: string) => void
  onReceiveMuteStatus: (peerId: string, isMuted: boolean) => void
  onPeerDisconnect: (peerId: string) => void
  onSpeakingStatusChange?: (peerId: string, isSpeaking: boolean) => void
  onReceiveScreenShareStatus?: (peerId: string, isSharing: boolean) => void
  onLocalScreenStreamUpdate?: (stream: MediaStream | null) => void
}

interface AudioAnalysisData {
  context: AudioContext
  analyser: AnalyserNode
  source: MediaStreamAudioSourceNode
  lastIsSpeaking: boolean
  animationFrameId: number | null
  dataArray: Uint8Array
}

// --- PeerManager クラス定義 ---
export class PeerManager {
  private peer: Peer | null = null
  private localStream: MediaStream | null = null
  private screenStream: MediaStream | null = null
  private screenShareTrackEndedListener: (() => void) | null = null
  private mediaConnections: { [id: string]: MediaConnection } = {}
  private dataConnections: { [id: string]: DataConnection } = {}
  private screenMediaConnections: { [id: string]: MediaConnection } = {}
  private options: InitPeerOptions | null = null // オプションを保持
  private myName = ''
  private isMuted = false
  private audioAnalysisMap = new Map<string, AudioAnalysisData>()
  private readonly speakingThreshold = 10

  // --- 型ガード関数 ---
  private isMessage(data: unknown): data is Message {
    if (typeof data !== 'object' || data === null) return false
    if (!('type' in data) || !('payload' in data)) return false
    const potentialMessage = data as { type: unknown; payload: unknown }
    switch (potentialMessage.type) {
      case 'USER_NAME':
        return typeof potentialMessage.payload === 'string'
      case 'MUTE_STATUS':
      case 'SCREEN_SHARE_STATUS':
        return typeof potentialMessage.payload === 'boolean'
      default:
        return false
    }
  }

  // --- 音声分析関連メソッド ---
  private startAudioAnalysis(peerId: string, stream: MediaStream) {
    if (this.audioAnalysisMap.has(peerId)) return
    const audioTracks = stream.getAudioTracks()
    if (audioTracks.length === 0) return

    try {
      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.3
      source.connect(analyser)
      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      const analysisData: AudioAnalysisData = {
        context,
        analyser,
        source,
        lastIsSpeaking: false,
        animationFrameId: null,
        dataArray,
      }
      this.audioAnalysisMap.set(peerId, analysisData)

      const analyse = () => {
        const currentAnalysisData = this.audioAnalysisMap.get(peerId)
        if (
          !currentAnalysisData?.analyser ||
          !currentAnalysisData?.dataArray ||
          currentAnalysisData.context.state !== 'running'
        ) {
          if (currentAnalysisData?.animationFrameId)
            cancelAnimationFrame(currentAnalysisData.animationFrameId)
          return
        }
        currentAnalysisData.animationFrameId = requestAnimationFrame(analyse)
        currentAnalysisData.analyser.getByteFrequencyData(
          currentAnalysisData.dataArray
        )
        let sum = 0
        for (let i = 0; i < currentAnalysisData.dataArray.length; i++)
          sum += currentAnalysisData.dataArray[i]
        const average = sum / currentAnalysisData.dataArray.length
        const isSpeaking = average > this.speakingThreshold

        if (isSpeaking !== currentAnalysisData.lastIsSpeaking) {
          console.log(
            `[PeerManager instance ${this.peer?.id}] Speaking status changed for ${peerId}: ${isSpeaking}`
          )
          currentAnalysisData.lastIsSpeaking = isSpeaking
          this.options?.onSpeakingStatusChange?.(peerId, isSpeaking)
        }
      }
      analyse()
      console.log(
        `[PeerManager instance ${this.peer?.id}] Started audio analysis for ${peerId}`
      )
    } catch (error) {
      console.error(
        `[PeerManager instance ${this.peer?.id}] Error starting audio analysis for ${peerId}:`,
        error
      )
      this.stopAudioAnalysis(peerId)
    }
  }

  private stopAudioAnalysis(peerId: string) {
    const analysisData = this.audioAnalysisMap.get(peerId)
    if (analysisData) {
      if (analysisData.animationFrameId !== null)
        cancelAnimationFrame(analysisData.animationFrameId)
      try {
        analysisData.source?.disconnect()
      } catch {
        /* ignore */
      }
      analysisData.context
        ?.close()
        .catch((e) =>
          console.error(`Error closing AudioContext for ${peerId}:`, e)
        )
      this.audioAnalysisMap.delete(peerId)
      console.log(
        `[PeerManager instance ${this.peer?.id}] Stopped audio analysis for ${peerId}`
      )
      this.options?.onSpeakingStatusChange?.(peerId, false)
    }
  }

  private stopAllAudioAnalysis() {
    this.audioAnalysisMap.forEach((_, peerId) => this.stopAudioAnalysis(peerId))
    this.audioAnalysisMap.clear()
  }

  // --- 接続処理関連メソッド ---
  private setupDataConnectionHandlers(dataConn: DataConnection) {
    dataConn.on('open', () => {
      console.log(
        `[PeerManager instance ${this.peer?.id}] Data connection opened with ${dataConn.peer}`
      )
      this.dataConnections[dataConn.peer] = dataConn
      this.sendMessage('USER_NAME', this.myName, dataConn.peer)
      this.sendMessage('MUTE_STATUS', this.isMuted, dataConn.peer)
      if (this.screenStream)
        this.sendMessage('SCREEN_SHARE_STATUS', true, dataConn.peer)
    })
    dataConn.on('data', (data) => {
      console.log(
        `[PeerManager instance ${this.peer?.id}] Received data from ${dataConn.peer}:`,
        data
      )
      if (this.isMessage(data) && this.options) {
        switch (data.type) {
          case 'USER_NAME':
            this.options.onReceiveUserName(dataConn.peer, data.payload)
            break
          case 'MUTE_STATUS':
            this.options.onReceiveMuteStatus(dataConn.peer, data.payload)
            break
          case 'SCREEN_SHARE_STATUS':
            this.options.onReceiveScreenShareStatus?.(
              dataConn.peer,
              data.payload
            )
            break
        }
      } else {
        console.warn(
          `[PeerManager instance ${this.peer?.id}] Received unknown message type:`,
          data
        )
      }
    })
    dataConn.on('close', () => {
      console.log(
        `[PeerManager instance ${this.peer?.id}] Data connection with ${dataConn.peer} closed.`
      )
      this.handleDisconnect(dataConn.peer)
    })
    dataConn.on('error', (err) => {
      console.error(
        `[PeerManager instance ${this.peer?.id}] Data connection error with ${dataConn.peer}:`,
        err
      )
      this.handleDisconnect(dataConn.peer)
    })
  }

  private handleDisconnect(peerId: string) {
    if (!peerId) return
    console.log(
      `[PeerManager instance ${this.peer?.id}] Handling disconnect for peer: ${peerId}`
    )
    this.stopAudioAnalysis(peerId) // 音声分析停止

    // 音声接続のクリーンアップ
    if (this.mediaConnections[peerId]) {
      this.mediaConnections[peerId].close()
      delete this.mediaConnections[peerId]
      console.log(
        `[PeerManager instance ${this.peer?.id}] Closed media connection with ${peerId}`
      )
    }
    // データ接続のクリーンアップ
    if (this.dataConnections[peerId]) {
      this.dataConnections[peerId].close()
      delete this.dataConnections[peerId]
      console.log(
        `[PeerManager instance ${this.peer?.id}] Closed data connection with ${peerId}`
      )
    }
    // ★ 画面共有接続のクリーンアップを追加
    if (this.screenMediaConnections[peerId]) {
      this.screenMediaConnections[peerId].close()
      delete this.screenMediaConnections[peerId]
      console.log(
        `[PeerManager instance ${this.peer?.id}] Closed screen media connection with ${peerId}`
      )
      // 相手が切断した場合、共有状態もリセット通知 (必要に応じて)
      this.options?.onReceiveScreenShareStatus?.(peerId, false)
    }

    this.options?.onPeerDisconnect(peerId) // 参加者削除通知
  }

  // --- メディアストリーム関連メソッド ---
  private async getLocalStream(deviceId?: string): Promise<MediaStream> {
    const currentAudioTrack = this.localStream?.getAudioTracks()[0]
    if (
      this.localStream &&
      (!deviceId || currentAudioTrack?.getSettings().deviceId === deviceId)
    ) {
      console.log(
        `[PeerManager instance ${this.peer?.id}] Returning cached local stream.`
      )
      return this.localStream
    }

    this.localStream?.getTracks().forEach((track) => track.stop())
    this.localStream = null
    console.log(
      `[PeerManager instance ${this.peer?.id}] Stopped existing local stream.`
    )

    try {
      console.log(
        `[PeerManager instance ${this.peer?.id}] Requesting local media stream (getUserMedia) with deviceId: ${deviceId || 'default'}`
      )
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      console.log(
        `[PeerManager instance ${this.peer?.id}] getUserMedia successful (audio only)!`
      )

      // 映像トラック無効化処理は不要

      this.localStream = stream
      this.options?.onLocalStream(stream) // 音声のみの stream を渡す
      console.log(
        `[PeerManager instance ${this.peer?.id}] Local media stream obtained and notified.`
      )
      const audioTrack = stream.getAudioTracks()[0]
      if (audioTrack) {
        audioTrack.enabled = !this.isMuted
      }
      return stream
    } catch (err) {
      console.error(
        `[PeerManager instance ${this.peer?.id}] Failed to get local media stream:`,
        err
      )
      // カメラ拒否時のフォールバックは不要に
      throw err
    }
  }

  // --- メッセージ送信メソッド --
  private sendMessage(
    type: Message['type'],
    payload: Message['payload'],
    targetId?: string
  ) {
    if (!this.peer) return
    const message = { type, payload } as Message
    try {
      if (targetId) {
        if (this.dataConnections[targetId]?.open) {
          console.log(
            `[PeerManager instance ${this.peer?.id}] Sending ${type} to ${targetId}:`,
            payload
          )
          this.dataConnections[targetId].send(message)
        } else {
          console.warn(
            `[PeerManager instance ${this.peer?.id}] Data connection to ${targetId} not open or doesn't exist.`
          )
        }
      } else {
        console.log(
          `[PeerManager instance ${this.peer?.id}] Sending ${type} to all connected peers:`,
          payload
        )
        Object.values(this.dataConnections).forEach((conn) => {
          if (conn.open) conn.send(message)
        })
      }
    } catch (error) {
      console.error(
        `[PeerManager instance ${this.peer?.id}] Error sending message ${type}:`,
        error
      )
    }
  }

  // --- 公開メソッド ---
  public async initPeer(
    options: InitPeerOptions,
    peerName: string,
    initialIsMuted: boolean = false
  ): Promise<string> {
    console.log('[PeerManager instance] initPeer called.')
    this.options = options
    this.myName = peerName
    this.isMuted = initialIsMuted

    if (this.peer) {
      console.error(
        '[PeerManager instance] initPeer called on an already initialized instance. Destroying previous peer.'
      )
      this.peer.destroy()
      this.peer = null
    }

    return new Promise<string>(async (resolve, reject) => {
      try {
        console.log('[PeerManager instance] Creating new Peer.')

        // PeerJS オプションでデバッグレベルを設定 (任意)
        const peerJsOptions: PeerJSOption = {
          debug: 2, // 0:なし, 1:エラー, 2:警告, 3:情報
        }
        this.peer = new Peer(peerJsOptions) // オプションを渡す

        this.peer.on('open', async (id) => {
          if (!this.peer || this.peer.destroyed) {
            console.warn(
              `[PeerManager instance] on 'open' called for ID ${id}, but instance peer is null or destroyed.`
            )
            return
          }
          console.log('[PeerManager instance] Peer opened with ID:', id)
          try {
            await this.getLocalStream()
            this.options?.onPeerOpen(id)
            resolve(id)
          } catch (streamError) {
            console.error(
              '[PeerManager instance] Failed to get local stream on peer open:',
              streamError
            )
            if (this.peer && !this.peer.destroyed) {
              this.peer.destroy()
              this.peer = null
            }
            reject(new Error('マイクへのアクセスに失敗しました。'))
          }
        })

        this.peer.on('connection', (dataConn) => {
          console.log(
            `[PeerManager instance ${this.peer?.id}] Incoming data connection from ${dataConn.peer}`
          )
          this.setupDataConnectionHandlers(dataConn)
        })

        this.peer.on('call', async (call) => {
          console.log(
            `[PeerManager instance ${this.peer?.id}] Incoming call from ${call.peer}, metadata:`,
            call.metadata
          )

          // ★ メタデータで画面共有か音声通話か判断
          if (call.metadata?.type === 'screenShare') {
            // --- 画面共有用の通話処理 ---
            console.log(
              `[PeerManager instance ${this.peer?.id}] Received screen share call from ${call.peer}`
            )
            call.answer() // 画面共有の受信側はストリームを送らない
            call.on('stream', (remoteScreenStream) => {
              console.log(
                `[PeerManager instance ${this.peer?.id}] Received screen stream from ${call.peer}`
              )
              this.options?.onReceiveScreenStream(remoteScreenStream, call.peer)
            })
            call.on('close', () => {
              console.log(
                `[PeerManager instance ${this.peer?.id}] Screen share call closed from ${call.peer}`
              )
              delete this.screenMediaConnections[call.peer]
              // 画面共有停止を通知
              this.options?.onReceiveScreenShareStatus?.(call.peer, false)
            })
            call.on('error', (err) => {
              console.error(
                `[PeerManager instance ${this.peer?.id}] Screen share call error with ${call.peer}:`,
                err
              )
              delete this.screenMediaConnections[call.peer]
              this.options?.onReceiveScreenShareStatus?.(call.peer, false)
            })
            this.screenMediaConnections[call.peer] = call // 画面共有接続として保存
          } else {
            // --- 通常の音声通話処理 ---
            console.log(
              `[PeerManager instance ${this.peer?.id}] Received audio call from ${call.peer}`
            )
            try {
              if (!this.localStream) await this.getLocalStream() // 音声ストリーム取得
              if (!this.localStream) {
                console.error(
                  `[PeerManager instance ${this.peer?.id}] Local stream is null. Cannot answer call.`
                )
                return
              }
              call.answer(this.localStream) // 音声ストリームで応答
              call.on('stream', (remoteStream) => {
                // このストリームは音声のはず
                console.log(
                  `[PeerManager instance ${this.peer?.id}] Received audio stream from ${call.peer} (on call answer)`
                )
                this.options?.onReceiveStream(remoteStream, call.peer)
                this.startAudioAnalysis(call.peer, remoteStream)
              })
              call.on('close', () => this.handleDisconnect(call.peer)) // 通常の切断処理
              call.on('error', (err) => {
                console.error(
                  `[PeerManager instance ${this.peer?.id}] Audio call error with ${call.peer}:`,
                  err
                )
                this.handleDisconnect(call.peer)
              })
              this.mediaConnections[call.peer] = call // 音声接続として保存
            } catch (err) {
              console.error(
                `[PeerManager instance ${this.peer?.id}] Error answering audio call:`,
                err
              )
            }
          }
        })

        this.peer.on('disconnected', () =>
          console.warn(
            `[PeerManager instance ${this.peer?.id}] Peer disconnected from server.`
          )
        )
        this.peer.on('close', () => {
          console.log(
            `[PeerManager instance ${this.peer?.id}] Peer connection closed.`
          )
          this.peer = null
        })
        this.peer.on('error', (err) => {
          console.error(
            `[PeerManager instance ${this.peer?.id}] PeerJS error:`,
            err
          )
          if (err.type === 'peer-unavailable') {
            const unavailablePeerId = err.message.match(/peer\s(.*?)\s/)?.[1]
            if (unavailablePeerId) this.handleDisconnect(unavailablePeerId)
          }
          if (
            ['server-error', 'socket-error', 'socket-closed'].includes(err.type)
          ) {
            if (this.peer && !this.peer.destroyed) {
              this.peer.destroy()
            }
            this.peer = null
          }
        })
      } catch (err) {
        console.error(
          '[PeerManager instance] Failed to initialize PeerJS:',
          err
        )
        if (this.peer && !this.peer.destroyed) {
          this.peer.destroy()
        }
        this.peer = null
        reject(err)
      }
    })
  }

  private async connectData(targetId: string): Promise<DataConnection | null> {
    if (!this.peer) return null
    if (this.dataConnections[targetId]?.open)
      return this.dataConnections[targetId]

    return new Promise((resolve) => {
      try {
        if (!this.peer) {
          resolve(null)
          return
        }
        console.log(
          `[PeerManager instance ${this.peer?.id}] Attempting to establish data connection with ${targetId}`
        )
        const dataConn = this.peer.connect(targetId)
        dataConn.on('open', () => {
          this.setupDataConnectionHandlers(dataConn)
          resolve(dataConn)
        })
        dataConn.on('error', (err) => {
          console.error(
            `[PeerManager instance ${this.peer?.id}] Data connection error with ${targetId}:`,
            err
          )
          delete this.dataConnections[targetId]
          resolve(null)
        })
      } catch (error) {
        console.error(
          `[PeerManager instance ${this.peer?.id}] Unexpected error in connectData for ${targetId}:`,
          error
        )
        resolve(null)
      }
    })
  }

  public async callPeer(targetId: string) {
    console.log(
      `[PeerManager instance ${this.peer?.id}] callPeer START for ${targetId}.`
    )
    if (!this.peer || !this.options) return
    if (this.mediaConnections[targetId]) return

    try {
      await this.connectData(targetId)
      if (!this.localStream) await this.getLocalStream()
      if (!this.peer || !this.localStream) return

      console.log(
        `[PeerManager instance ${this.peer?.id}] Calling peer: ${targetId}`
      )
      const call = this.peer.call(targetId, this.localStream)
      call.on('stream', (remoteStream) => {
        console.log(
          `[PeerManager instance ${this.peer?.id}] Received stream from ${targetId} (on call)`
        )
        if (remoteStream.getVideoTracks().length > 0) {
          this.options?.onReceiveScreenStream(remoteStream, call.peer)
        } else {
          this.options?.onReceiveStream(remoteStream, call.peer)
          this.startAudioAnalysis(call.peer, remoteStream)
        }
      })
      call.on('close', () => this.handleDisconnect(targetId))
      call.on('error', (err) => {
        console.error(
          `[PeerManager instance ${this.peer?.id}] Call error with ${targetId}:`,
          err
        )
        this.handleDisconnect(targetId)
      })
      this.mediaConnections[targetId] = call
    } catch (err) {
      console.error(
        `[PeerManager instance ${this.peer?.id}] Error calling peer ${targetId}:`,
        err
      )
      this.handleDisconnect(targetId)
    }
  }

  public sendUserName(name: string) {
    this.myName = name
    this.sendMessage('USER_NAME', name)
  }

  public sendMuteStatus(muted: boolean) {
    this.isMuted = muted
    this.localStream
      ?.getAudioTracks()
      .forEach((track) => (track.enabled = !this.isMuted))
    this.sendMessage('MUTE_STATUS', this.isMuted)
  }

  private async replaceTrackForAllConnections(
    newTrack: MediaStreamTrack | null,
    kind: 'audio' | 'video' // video も受け取れるようにしておく
  ) {
    // このメソッドは主に音声トラックの置換に使われる想定
    console.log(
      `[PeerManager instance ${this.peer?.id}] Replacing ${kind} track for all connections with track:`,
      newTrack?.id ?? 'null'
    )
    if (Object.keys(this.mediaConnections).length === 0) {
      console.log(
        `[PeerManager instance ${this.peer?.id}] No media connections to replace track on.`
      )
      return
    }

    // 音声通話用の接続 (mediaConnections) に対してのみ処理を行う
    for (const peerId in this.mediaConnections) {
      const conn = this.mediaConnections[peerId]
      const peerConnection = conn.peerConnection as
        | RTCPeerConnection
        | undefined

      if (peerConnection) {
        const sender = peerConnection
          .getSenders()
          .find((s) => s.track?.kind === kind)
        if (sender) {
          console.log(
            `[PeerManager instance ${this.peer?.id}] Found sender for ${kind} track for connection with ${peerId}. Current track: ${sender.track?.id ?? 'null'}`
          )
          try {
            console.log(
              `[PeerManager instance ${this.peer?.id}] Attempting sender.replaceTrack() for ${peerId}...`
            )
            await sender.replaceTrack(newTrack)
            console.log(
              `[PeerManager instance ${this.peer?.id}] Successfully replaced ${kind} track for ${peerId}. New track: ${sender.track?.id ?? 'null'}`
            )
          } catch (replaceError) {
            console.error(
              `[PeerManager instance ${this.peer?.id}] Failed to replace ${kind} track for ${peerId}:`,
              replaceError
            )
          }
        } else {
          console.warn(
            `[PeerManager instance ${this.peer?.id}] Could not find sender for ${kind} track for ${peerId}.`
          )
        }
      } else {
        console.warn(
          `[PeerManager instance ${this.peer?.id}] No peerConnection found for media connection with ${peerId}.`
        )
      }
    }
  }

  public async switchMicrophone(newDeviceId: string) {
    console.log(
      `[PeerManager instance ${this.peer?.id}] Attempting to switch microphone to ${newDeviceId}`
    )
    const currentAudioTrack = this.localStream?.getAudioTracks()[0]
    if (currentAudioTrack?.getSettings().deviceId === newDeviceId) return

    try {
      const newStream = await this.getLocalStream(newDeviceId)
      const newAudioTrack = newStream.getAudioTracks()[0]
      if (!newAudioTrack) throw new Error('Failed to get new audio track.')
      await this.replaceTrackForAllConnections(newAudioTrack, 'audio')
      console.log(
        `[PeerManager instance ${this.peer?.id}] Microphone switched successfully.`
      )
    } catch (error) {
      console.error(
        `[PeerManager instance ${this.peer?.id}] Failed to switch microphone:`,
        error
      )
      throw error
    }
  }

  public async startScreenShare() {
    // ★ ログ出力用に peerId を安全に取得
    const peerIdForLog = this.peer?.id ?? 'N/A'
    console.log(
      `[PeerManager instance ${this.peer?.id}] Attempting to start screen share.`
    )
    if (this.screenStream) {
      console.warn(
        `[PeerManager instance ${this.peer?.id}] Screen sharing is already active.`
      )
      return // 既に共有中の場合は何もしない
    }
    if (!this.peer) {
      console.error(
        `[PeerManager instance ${peerIdForLog}] Peer is not initialized. Cannot start screen share.`
      )
      return
    }

    let screenVideoTrack: MediaStreamTrack | undefined
    try {
      // 1. 画面共有ストリームを取得
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false, // 通常は音声を含めない
      })
      screenVideoTrack = this.screenStream.getVideoTracks()[0]
      if (!screenVideoTrack)
        throw new Error('Failed to get video track from screen stream.')
      this.options?.onLocalScreenStreamUpdate?.(this.screenStream)
      // 2. 共有終了時のリスナーを設定
      this.screenShareTrackEndedListener = () => {
        console.log(
          `[PeerManager instance ${this.peer?.id}] Screen share track ended event received.`
        )
        this.stopScreenShare() // トラックが停止したら共有も停止
      }
      screenVideoTrack.addEventListener(
        'ended',
        this.screenShareTrackEndedListener
      )

      // 3. 接続中の各ピアに画面共有用の新しい call を開始
      const connectedPeerIds = Object.keys(this.dataConnections) // データ接続があるピアを対象とする
      console.log(
        `[PeerManager instance ${this.peer?.id}] Starting screen share calls to peers:`,
        connectedPeerIds
      )

      for (const peerId of connectedPeerIds) {
        if (this.screenMediaConnections[peerId]) {
          console.warn(
            `[PeerManager instance ${this.peer?.id}] Screen share connection already exists for ${peerId}. Skipping.`
          )
          continue
        }

        if (!this.peer || !this.screenStream) {
          console.error(
            `[PeerManager instance] Peer or screenStream became null unexpectedly before calling ${peerId}.`
          )
          continue // このピアへの処理をスキップ
        }

        console.log(
          // this.peer が null でないことが保証されたので ?. を外す
          `[PeerManager instance ${this.peer?.id}] Calling ${peerId} for screen share...`
        )
        // this.peer と this.screenStream が null でないことを TypeScript に伝える
        const screenCall = this.peer.call(peerId, this.screenStream, {
          metadata: { type: 'screenShare' },
        })
        // ↑↑↑ ここまで追加/修正 ↑↑↑

        // screenCall のイベントハンドラ (エラーやクローズ)
        screenCall.on('close', () => {
          console.log(
            `[PeerManager instance ${this.peer?.id}] Screen share call closed with ${peerId} (initiated side).`
          )
          delete this.screenMediaConnections[peerId]
        })
        screenCall.on('error', (err) => {
          console.error(
            `[PeerManager instance ${this.peer?.id}] Screen share call error with ${peerId} (initiated side):`,
            err
          )
          delete this.screenMediaConnections[peerId]
        })

        this.screenMediaConnections[peerId] = screenCall
      }

      // 4. 他のピアに画面共有開始を通知 (DataConnection経由)
      this.sendMessage('SCREEN_SHARE_STATUS', true)
      console.log(
        `[PeerManager instance ${this.peer?.id}] Screen sharing initiated and notified.`
      )
    } catch (error) {
      console.error(
        `[PeerManager instance ${this.peer?.id}] Failed to start screen share:`,
        error
      )
      // エラー発生時のクリーンアップ
      const tracksToStop = this.screenStream?.getTracks()
      tracksToStop?.forEach((track) => track.stop())
      this.screenStream = null
      if (this.screenShareTrackEndedListener && screenVideoTrack) {
        try {
          screenVideoTrack.removeEventListener(
            'ended',
            this.screenShareTrackEndedListener
          )
        } catch (removeError) {
          console.error("Error removing 'ended' listener:", removeError)
        }
      }
      this.screenShareTrackEndedListener = null
      // 開始に失敗した場合、確立した可能性のある screenMediaConnections も閉じる
      Object.values(this.screenMediaConnections).forEach((conn) => conn.close())
      this.screenMediaConnections = {}
      this.options?.onLocalScreenStreamUpdate?.(null)
      throw error // エラーを再スロー
    }
  }

  public async stopScreenShare() {
    console.log(
      `[PeerManager instance ${this.peer?.id}] Attempting to stop screen share.`
    )
    if (
      !this.screenStream &&
      Object.keys(this.screenMediaConnections).length === 0
    ) {
      console.log(
        `[PeerManager instance ${this.peer?.id}] Screen sharing is not active.`
      )
      return // 共有中でなければ何もしない
    }

    // 1. 'ended' リスナーを削除
    const screenVideoTrack = this.screenStream?.getVideoTracks()[0]
    if (this.screenShareTrackEndedListener && screenVideoTrack) {
      try {
        screenVideoTrack.removeEventListener(
          'ended',
          this.screenShareTrackEndedListener
        )
      } catch (removeError) {
        console.error("Error removing 'ended' listener:", removeError)
      }
      this.screenShareTrackEndedListener = null
    }

    // 2. ローカルの画面共有ストリームを停止
    this.screenStream?.getTracks().forEach((track) => track.stop())
    this.screenStream = null
    this.options?.onLocalScreenStreamUpdate?.(null)
    // 3. 画面共有用の接続をすべて閉じる
    console.log(
      `[PeerManager instance ${this.peer?.id}] Closing all screen share connections.`
    )
    Object.values(this.screenMediaConnections).forEach((conn) => conn.close())
    this.screenMediaConnections = {} // 接続情報をクリア

    // 4. 他のピアに画面共有停止を通知
    this.sendMessage('SCREEN_SHARE_STATUS', false)
    console.log(
      `[PeerManager instance ${this.peer?.id}] Screen sharing stopped and notified.`
    )

    // replaceTrack や originalVideoTrack の処理は不要
  }

  public disconnectAll() {
    console.log(`[PeerManager instance ${this.peer?.id}] disconnectAll called.`)
    this.stopScreenShare() // 画面共有停止処理を呼ぶ (内部で screenMediaConnections もクリアされる)
    this.stopAllAudioAnalysis()

    // 音声接続とデータ接続を閉じる
    Object.values(this.mediaConnections).forEach((conn) => conn.close())
    Object.values(this.dataConnections).forEach((conn) => conn.close())
    this.mediaConnections = {}
    this.dataConnections = {}
    // screenMediaConnections は stopScreenShare でクリアされるのでここでは不要

    // Peer オブジェクト破棄
    if (this.peer && !this.peer.destroyed) {
      console.log(
        `[PeerManager instance ${this.peer?.id}] Destroying peer instance.`
      )
      this.peer.destroy()
    }
    this.peer = null

    // ローカルストリーム停止
    this.localStream?.getTracks().forEach((track) => track.stop())
    this.localStream = null
    // screenStream は stopScreenShare で停止されるのでここでは不要

    // 他のプロパティリセット
    this.options = null
    this.myName = ''
    this.isMuted = false

    console.log(`[PeerManager instance] Disconnected and resources released.`)
  }
}
