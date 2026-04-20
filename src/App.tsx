import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import './App.css'

type AssetFile = {
  key: string
  name: string
  url: string
}

type Tool = 'inspect' | 'paint' | 'erase'

type PixelDocument = {
  width: number
  height: number
  pixels: Uint8ClampedArray
}

const MIN_ZOOM = 2
const MAX_ZOOM = 64

const assetModules = import.meta.glob('../assets/**/*.png', {
  eager: true,
  import: 'default',
}) as Record<string, string>

const assets: AssetFile[] = Object.entries(assetModules)
  .map(([modulePath, url]) => {
    const key = modulePath.replace('../assets/', '')
    const pathParts = key.split('/')

    return {
      key,
      name: pathParts[pathParts.length - 1] ?? key,
      url,
    }
  })
  .sort((a, b) => a.key.localeCompare(b.key))

const loadPixelDocument = async (assetUrl: string): Promise<PixelDocument> => {
  const image = new Image()
  image.src = assetUrl

  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('Failed to load selected image.'))
  })

  const width = image.naturalWidth
  const height = image.naturalHeight

  const scratchCanvas = document.createElement('canvas')
  scratchCanvas.width = width
  scratchCanvas.height = height

  const scratchContext = scratchCanvas.getContext('2d')

  if (!scratchContext) {
    throw new Error('Canvas context unavailable.')
  }

  scratchContext.imageSmoothingEnabled = false
  scratchContext.clearRect(0, 0, width, height)
  scratchContext.drawImage(image, 0, 0)

  const imageData = scratchContext.getImageData(0, 0, width, height)

  return {
    width,
    height,
    pixels: imageData.data,
  }
}

const App = () => {
  const [isAssetModalOpen, setIsAssetModalOpen] = useState(false)
  const [currentPath, setCurrentPath] = useState<string[]>([])
  const [selectedAssetKey, setSelectedAssetKey] = useState<string | null>(null)
  const [pixelDocument, setPixelDocument] = useState<PixelDocument | null>(null)
  const [activeTool] = useState<Tool>('inspect')

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)

  const [viewportSize, setViewportSize] = useState({ width: 1, height: 1 })
  const [zoom, setZoom] = useState(16)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isGridVisible, setIsGridVisible] = useState(true)
  const [dragState, setDragState] = useState<
    | {
        startX: number
        startY: number
        originX: number
        originY: number
      }
    | null
  >(null)

  const { directories, files } = useMemo(() => {
    const prefix = currentPath.length > 0 ? `${currentPath.join('/')}/` : ''
    const foundDirectories = new Set<string>()
    const foundFiles: AssetFile[] = []

    assets.forEach((asset) => {
      if (!asset.key.startsWith(prefix)) {
        return
      }

      const remainder = asset.key.slice(prefix.length)
      const pathSegments = remainder.split('/')

      if (pathSegments.length > 1) {
        foundDirectories.add(pathSegments[0])
      } else {
        foundFiles.push(asset)
      }
    })

    return {
      directories: Array.from(foundDirectories).sort((a, b) => a.localeCompare(b)),
      files: foundFiles.sort((a, b) => a.name.localeCompare(b.name)),
    }
  }, [currentPath])

  const selectedAsset = useMemo(
    () => assets.find((asset) => asset.key === selectedAssetKey) ?? null,
    [selectedAssetKey],
  )

  useEffect(() => {
    const viewportElement = viewportRef.current

    if (!viewportElement) {
      return
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]

      if (!entry) {
        return
      }

      setViewportSize({
        width: Math.max(1, Math.floor(entry.contentRect.width)),
        height: Math.max(1, Math.floor(entry.contentRect.height)),
      })
    })

    observer.observe(viewportElement)

    return () => {
      observer.disconnect()
    }
  }, [pixelDocument])

  useEffect(() => {
    if (!pixelDocument) {
      return
    }

    const fitZoom = Math.max(
      MIN_ZOOM,
      Math.min(
        MAX_ZOOM,
        Math.floor(Math.min(viewportSize.width / pixelDocument.width, viewportSize.height / pixelDocument.height)),
      ),
    )

    const centeredPan = {
      x: Math.round((viewportSize.width - pixelDocument.width * fitZoom) / 2),
      y: Math.round((viewportSize.height - pixelDocument.height * fitZoom) / 2),
    }

    setZoom(fitZoom)
    setPan(centeredPan)
  }, [pixelDocument, viewportSize.height, viewportSize.width])

  useEffect(() => {
    const canvas = canvasRef.current

    if (!canvas) {
      return
    }

    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.floor(viewportSize.width * dpr))
    canvas.height = Math.max(1, Math.floor(viewportSize.height * dpr))

    const context = canvas.getContext('2d')

    if (!context) {
      return
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, viewportSize.width, viewportSize.height)

    if (!pixelDocument) {
      return
    }

    context.imageSmoothingEnabled = false

    const snapToDevicePixel = (value: number) => Math.round(value * dpr) / dpr

    const pixelSize = Math.max(1 / dpr, snapToDevicePixel(zoom))
    const drawPan = {
      x: snapToDevicePixel(pan.x),
      y: snapToDevicePixel(pan.y),
    }

    for (let y = 0; y < pixelDocument.height; y += 1) {
      for (let x = 0; x < pixelDocument.width; x += 1) {
        const index = (y * pixelDocument.width + x) * 4
        const red = pixelDocument.pixels[index]
        const green = pixelDocument.pixels[index + 1]
        const blue = pixelDocument.pixels[index + 2]
        const alpha = pixelDocument.pixels[index + 3] / 255

        context.fillStyle = `rgba(${red}, ${green}, ${blue}, ${alpha})`
        context.fillRect(drawPan.x + x * pixelSize, drawPan.y + y * pixelSize, pixelSize, pixelSize)
      }
    }

    if (isGridVisible && pixelSize >= 8) {
      context.strokeStyle = 'rgba(20, 23, 31, 0.4)'
      context.lineWidth = 1
      context.beginPath()

      for (let x = 0; x <= pixelDocument.width; x += 1) {
        const lineX = drawPan.x + x * pixelSize
        context.moveTo(lineX + 0.5, drawPan.y + 0.5)
        context.lineTo(lineX + 0.5, drawPan.y + pixelDocument.height * pixelSize + 0.5)
      }

      for (let y = 0; y <= pixelDocument.height; y += 1) {
        const lineY = drawPan.y + y * pixelSize
        context.moveTo(drawPan.x + 0.5, lineY + 0.5)
        context.lineTo(drawPan.x + pixelDocument.width * pixelSize + 0.5, lineY + 0.5)
      }

      context.stroke()
    }

    if (isGridVisible) {
      context.strokeStyle = '#7180a0'
      context.lineWidth = 2
      context.strokeRect(drawPan.x, drawPan.y, pixelDocument.width * pixelSize, pixelDocument.height * pixelSize)
    }
  }, [isGridVisible, pan.x, pan.y, pixelDocument, viewportSize.height, viewportSize.width, zoom])

  useEffect(() => {
    if (!dragState) {
      return
    }

    const handleMouseMove = (event: MouseEvent) => {
      setPan({
        x: dragState.originX + (event.clientX - dragState.startX),
        y: dragState.originY + (event.clientY - dragState.startY),
      })
    }

    const handleMouseUp = () => {
      setDragState(null)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [dragState])

  useEffect(() => {
    const handleGridToggle = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'h') {
        return
      }

      if (event.repeat) {
        return
      }

      setIsGridVisible((previousState) => !previousState)
    }

    window.addEventListener('keydown', handleGridToggle)

    return () => {
      window.removeEventListener('keydown', handleGridToggle)
    }
  }, [])

  const zoomAtPoint = useCallback(
    (pointerX: number, pointerY: number, getNextZoom: (previousZoom: number) => number) => {
    setZoom((previousZoom) => {
      const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, getNextZoom(previousZoom)))

      if (nextZoom === previousZoom) {
        return previousZoom
      }

      setPan((previousPan) => {
        const worldX = (pointerX - previousPan.x) / previousZoom
        const worldY = (pointerY - previousPan.y) / previousZoom

        return {
          x: pointerX - worldX * nextZoom,
          y: pointerY - worldY * nextZoom,
        }
      })

      return nextZoom
    })
    },
    [],
  )

  const openAssetModal = () => {
    setIsAssetModalOpen(true)
    setCurrentPath([])
    setSelectedAssetKey(null)
  }

  const closeAssetModal = () => {
    setIsAssetModalOpen(false)
    setCurrentPath([])
    setSelectedAssetKey(null)
  }

  const goUpLayer = () => {
    setCurrentPath((previousPath) => previousPath.slice(0, -1))
  }

  const openDirectory = (folderName: string) => {
    setCurrentPath((previousPath) => [...previousPath, folderName])
  }

  const loadSelectedAsset = async () => {
    if (!selectedAsset) {
      return
    }

    const document = await loadPixelDocument(selectedAsset.url)
    setPixelDocument(document)
    closeAssetModal()
  }

  useEffect(() => {
    const viewportElement = viewportRef.current

    if (!viewportElement || !pixelDocument) {
      return
    }

    const handleWheelZoom = (event: globalThis.WheelEvent) => {
      event.preventDefault()

      const bounds = viewportElement.getBoundingClientRect()
      const pointerX = event.clientX - bounds.left
      const pointerY = event.clientY - bounds.top
      const zoomFactor = Math.exp(-event.deltaY * 0.002)

      zoomAtPoint(pointerX, pointerY, (previousZoom) => previousZoom * zoomFactor)
    }

    viewportElement.addEventListener('wheel', handleWheelZoom, { passive: false })

    return () => {
      viewportElement.removeEventListener('wheel', handleWheelZoom)
    }
  }, [pixelDocument, zoomAtPoint])

  const handleZoomButton = (zoomDelta: number) => {
    const viewportElement = viewportRef.current

    if (!viewportElement || !pixelDocument) {
      return
    }

    const pointerX = viewportElement.clientWidth / 2
    const pointerY = viewportElement.clientHeight / 2

    zoomAtPoint(pointerX, pointerY, (previousZoom) => previousZoom + zoomDelta)
  }

  const handleViewportMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!pixelDocument || event.button !== 0) {
      return
    }

    event.preventDefault()

    setDragState({
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y,
    })
  }

  const directoryPathLabel = currentPath.length > 0 ? `/${currentPath.join('/')}` : '/'

  return (
    <div className="app-frame">
      <aside className="sidebar">
        <button className="load-asset-button" onClick={openAssetModal}>
          Load Asset
        </button>

        <section className="tools-section">
          <h3 className="tools-title">Tools</h3>
          <div className="tools-row">
            <button className={`tool-button ${activeTool === 'inspect' ? 'active' : ''}`}>Inspect</button>
            <button className="tool-button">Paint</button>
            <button className="tool-button">Erase</button>
          </div>
        </section>
      </aside>

      <main className="main-area">
        {pixelDocument ? (
          <div
            ref={viewportRef}
            className="canvas-viewport"
            onMouseDown={handleViewportMouseDown}
          >
            <canvas ref={canvasRef} className="pixel-canvas" />
            <div className="zoom-controls" aria-label="Zoom controls">
              <button className="zoom-button" onClick={() => handleZoomButton(2)} aria-label="Zoom in">
                +
              </button>
              <button className="zoom-button" onClick={() => handleZoomButton(-2)} aria-label="Zoom out">
                -
              </button>
            </div>
          </div>
        ) : (
          <p className="placeholder-text">No asset loaded yet.</p>
        )}
      </main>

      {isAssetModalOpen ? (
        <div className="modal-overlay">
          <div className="modal-window">
            <div className="modal-header-row">
              <h2 className="modal-title">Load Asset</h2>
              <span className="path-label">{directoryPathLabel}</span>
            </div>

            <div className="controls-row">
              <button className="layer-up-button" onClick={goUpLayer} disabled={currentPath.length === 0}>
                Layer Up
              </button>
            </div>

            <div className="asset-list-area">
              {directories.map((directory) => (
                <button
                  key={directory}
                  className="folder-row"
                  onClick={() => openDirectory(directory)}
                >
                  📁 {directory}
                </button>
              ))}

              {files.map((file) => (
                <button
                  key={file.key}
                  className={`file-preview-button ${selectedAssetKey === file.key ? 'selected' : ''}`}
                  onClick={() => setSelectedAssetKey(file.key)}
                >
                  <img src={file.url} alt={file.name} className="file-thumbnail" />
                  <span className="file-name-label">{file.name}</span>
                </button>
              ))}

              {directories.length === 0 && files.length === 0 ? (
                <p className="empty-state-text">No PNG assets in this folder.</p>
              ) : null}
            </div>

            <div className="modal-footer">
              <button className="cancel-button" onClick={closeAssetModal}>
                Cancel
              </button>
              <button
                className={`confirm-load-button ${selectedAsset ? 'enabled' : ''}`}
                onClick={loadSelectedAsset}
                disabled={!selectedAsset}
              >
                Load
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default App
