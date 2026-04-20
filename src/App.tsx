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

type Color = {
  r: number
  g: number
  b: number
  a: number
}

type PixelPosition = {
  x: number
  y: number
}

const MIN_ZOOM = 2
const MAX_ZOOM = 64
const MAX_RECENT_COLORS = 5

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

const clampColorChannel = (value: number) => Math.max(0, Math.min(255, Math.round(value)))

const areColorsEqual = (left: Color, right: Color) =>
  left.r === right.r && left.g === right.g && left.b === right.b && left.a === right.a

const colorToCss = (color: Color) => `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a / 255})`

const colorToKey = (color: Color) => `${color.r}-${color.g}-${color.b}-${color.a}`

const getDocumentPixel = (document: PixelDocument, x: number, y: number): Color => {
  const index = (y * document.width + x) * 4

  return {
    r: document.pixels[index],
    g: document.pixels[index + 1],
    b: document.pixels[index + 2],
    a: document.pixels[index + 3],
  }
}

const App = () => {
  const [isAssetModalOpen, setIsAssetModalOpen] = useState(false)
  const [currentPath, setCurrentPath] = useState<string[]>([])
  const [selectedAssetKey, setSelectedAssetKey] = useState<string | null>(null)
  const [pixelDocument, setPixelDocument] = useState<PixelDocument | null>(null)
  const [activeTool, setActiveTool] = useState<Tool>('inspect')
  const [isColorPickerActive, setIsColorPickerActive] = useState(false)
  const [activeColor, setActiveColor] = useState<Color>({ r: 0, g: 0, b: 0, a: 255 })
  const [recentColors, setRecentColors] = useState<Color[]>([{ r: 0, g: 0, b: 0, a: 255 }])

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const documentCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const documentContextRef = useRef<CanvasRenderingContext2D | null>(null)

  const pixelDocumentRef = useRef<PixelDocument | null>(null)
  const [documentRenderVersion, setDocumentRenderVersion] = useState(0)

  const [viewportSize, setViewportSize] = useState({ width: 1, height: 1 })
  const [zoom, setZoom] = useState(16)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isGridVisible, setIsGridVisible] = useState(true)
  const [hoverPixel, setHoverPixel] = useState<PixelPosition | null>(null)

  const [dragState, setDragState] = useState<
    | {
        startX: number
        startY: number
        originX: number
        originY: number
      }
    | null
  >(null)

  const [paintDragState, setPaintDragState] = useState<{ isDrawing: boolean; lastPixelKey: string | null }>({
    isDrawing: false,
    lastPixelKey: null,
  })

  useEffect(() => {
    pixelDocumentRef.current = pixelDocument
  }, [pixelDocument])

  const commitActiveColor = useCallback((nextColor: Color) => {
    const normalizedColor = {
      r: clampColorChannel(nextColor.r),
      g: clampColorChannel(nextColor.g),
      b: clampColorChannel(nextColor.b),
      a: clampColorChannel(nextColor.a),
    }

    setActiveColor(normalizedColor)
    setRecentColors((previousColors) => {
      const deduped = previousColors.filter((color) => !areColorsEqual(color, normalizedColor))
      return [normalizedColor, ...deduped].slice(0, MAX_RECENT_COLORS)
    })
  }, [])

  const setPixelColor = useCallback((position: PixelPosition, color: Color) => {
    const document = pixelDocumentRef.current

    if (!document) {
      return false
    }

    if (position.x < 0 || position.x >= document.width || position.y < 0 || position.y >= document.height) {
      return false
    }

    const index = (position.y * document.width + position.x) * 4
    const nextR = clampColorChannel(color.r)
    const nextG = clampColorChannel(color.g)
    const nextB = clampColorChannel(color.b)
    const nextA = clampColorChannel(color.a)

    if (
      document.pixels[index] === nextR &&
      document.pixels[index + 1] === nextG &&
      document.pixels[index + 2] === nextB &&
      document.pixels[index + 3] === nextA
    ) {
      return false
    }

    document.pixels[index] = nextR
    document.pixels[index + 1] = nextG
    document.pixels[index + 2] = nextB
    document.pixels[index + 3] = nextA

    const documentContext = documentContextRef.current
    if (documentContext) {
      documentContext.clearRect(position.x, position.y, 1, 1)
      documentContext.fillStyle = colorToCss({ r: nextR, g: nextG, b: nextB, a: nextA })
      documentContext.fillRect(position.x, position.y, 1, 1)
    }

    setDocumentRenderVersion((version) => version + 1)
    return true
  }, [])

  const getPixelFromClientPoint = useCallback(
    (clientX: number, clientY: number): PixelPosition | null => {
      const viewportElement = viewportRef.current
      const document = pixelDocumentRef.current

      if (!viewportElement || !document) {
        return null
      }

      const bounds = viewportElement.getBoundingClientRect()
      const localX = clientX - bounds.left
      const localY = clientY - bounds.top

      const pixelX = Math.floor((localX - pan.x) / zoom)
      const pixelY = Math.floor((localY - pan.y) / zoom)

      if (pixelX < 0 || pixelX >= document.width || pixelY < 0 || pixelY >= document.height) {
        return null
      }

      return { x: pixelX, y: pixelY }
    },
    [pan.x, pan.y, zoom],
  )

  const drawPaintPixel = useCallback(
    (position: PixelPosition) => {
      const changed = setPixelColor(position, activeColor)

      if (changed) {
        setRecentColors((previousColors) => {
          const deduped = previousColors.filter((color) => !areColorsEqual(color, activeColor))
          return [activeColor, ...deduped].slice(0, MAX_RECENT_COLORS)
        })
      }
    },
    [activeColor, setPixelColor],
  )

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
      documentCanvasRef.current = null
      documentContextRef.current = null
      return
    }

    const bufferCanvas = document.createElement('canvas')
    bufferCanvas.width = pixelDocument.width
    bufferCanvas.height = pixelDocument.height

    const bufferContext = bufferCanvas.getContext('2d')

    if (!bufferContext) {
      throw new Error('Canvas context unavailable.')
    }

    const imageData = new ImageData(
      new Uint8ClampedArray(pixelDocument.pixels),
      pixelDocument.width,
      pixelDocument.height,
    )

    bufferContext.putImageData(imageData, 0, 0)
    documentCanvasRef.current = bufferCanvas
    documentContextRef.current = bufferContext
    setDocumentRenderVersion((version) => version + 1)
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

    const documentCanvas = documentCanvasRef.current
    if (documentCanvas) {
      context.drawImage(
        documentCanvas,
        drawPan.x,
        drawPan.y,
        pixelDocument.width * pixelSize,
        pixelDocument.height * pixelSize,
      )
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

    if (activeTool === 'paint' && hoverPixel) {
      context.strokeStyle = '#ffffff'
      context.lineWidth = 1
      context.strokeRect(
        drawPan.x + hoverPixel.x * pixelSize + 0.5,
        drawPan.y + hoverPixel.y * pixelSize + 0.5,
        Math.max(pixelSize - 1, 1),
        Math.max(pixelSize - 1, 1),
      )
    }

    if (isGridVisible) {
      context.strokeStyle = '#7180a0'
      context.lineWidth = 2
      context.strokeRect(drawPan.x, drawPan.y, pixelDocument.width * pixelSize, pixelDocument.height * pixelSize)
    }
  }, [documentRenderVersion, hoverPixel, isGridVisible, pan.x, pan.y, pixelDocument, viewportSize.height, viewportSize.width, zoom, activeTool])

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
    if (!paintDragState.isDrawing) {
      return
    }

    const handleMouseMove = (event: MouseEvent) => {
      const pixel = getPixelFromClientPoint(event.clientX, event.clientY)
      setHoverPixel(pixel)

      if (!pixel) {
        return
      }

      const pixelKey = `${pixel.x},${pixel.y}`

      setPaintDragState((previousState) => {
        if (previousState.lastPixelKey === pixelKey) {
          return previousState
        }

        drawPaintPixel(pixel)

        return {
          ...previousState,
          lastPixelKey: pixelKey,
        }
      })
    }

    const handleMouseUp = () => {
      setPaintDragState({ isDrawing: false, lastPixelKey: null })
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [drawPaintPixel, getPixelFromClientPoint, paintDragState.isDrawing])

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
    setHoverPixel(null)
    setPaintDragState({ isDrawing: false, lastPixelKey: null })
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

  const handleViewportMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (activeTool !== 'paint' || !pixelDocument) {
      setHoverPixel(null)
      return
    }

    setHoverPixel(getPixelFromClientPoint(event.clientX, event.clientY))
  }

  const handleViewportMouseLeave = () => {
    setHoverPixel(null)
  }

  const handleViewportMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!pixelDocument || event.button !== 0) {
      return
    }

    if (isColorPickerActive) {
      const pixel = getPixelFromClientPoint(event.clientX, event.clientY)
      if (!pixel) {
        return
      }

      const color = getDocumentPixel(pixelDocument, pixel.x, pixel.y)
      commitActiveColor(color)
      setIsColorPickerActive(false)
      event.preventDefault()
      return
    }

    if (activeTool === 'paint') {
      const pixel = getPixelFromClientPoint(event.clientX, event.clientY)
      if (!pixel) {
        return
      }

      event.preventDefault()
      drawPaintPixel(pixel)
      setPaintDragState({ isDrawing: true, lastPixelKey: `${pixel.x},${pixel.y}` })
      setHoverPixel(pixel)
      return
    }

    if (activeTool === 'inspect') {
      event.preventDefault()

      setDragState({
        startX: event.clientX,
        startY: event.clientY,
        originX: pan.x,
        originY: pan.y,
      })
    }
  }

  const handleToolSelect = (tool: Tool) => {
    setActiveTool(tool)
    if (tool !== 'paint') {
      setHoverPixel(null)
      setPaintDragState({ isDrawing: false, lastPixelKey: null })
    }
  }

  const handleColorPickerClick = () => {
    setIsColorPickerActive((previousState) => !previousState)
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
            <button
              className={`tool-button ${activeTool === 'inspect' ? 'active' : ''}`}
              onClick={() => handleToolSelect('inspect')}
            >
              Inspect
            </button>
            <button
              className={`tool-button ${activeTool === 'paint' ? 'active' : ''}`}
              onClick={() => handleToolSelect('paint')}
            >
              Paint
            </button>
            <button
              className={`tool-button ${activeTool === 'erase' ? 'active' : ''}`}
              onClick={() => handleToolSelect('erase')}
            >
              Erase
            </button>
          </div>
        </section>

        <section className="tools-section">
          <h3 className="tools-title">Color</h3>
          <div className="color-tools-row">
            <button className="tool-button">Color Wheel</button>
            <button
              className={`tool-button ${isColorPickerActive ? 'active' : ''}`}
              onClick={handleColorPickerClick}
            >
              Color Picker
            </button>
          </div>
          <div className="recent-header-row">
            <span className="recent-title">Recent</span>
          </div>
          <div className="recent-colors-row">
            {Array.from({ length: MAX_RECENT_COLORS }).map((_, index) => {
              const color = recentColors[index]
              const isActive = color ? areColorsEqual(color, activeColor) : false
              const colorKey = color ? colorToKey(color) : `empty-${index}`

              return (
                <button
                  key={colorKey}
                  className={`recent-color-swatch ${isActive ? 'active' : ''}`}
                  style={
                    color
                      ? { backgroundColor: colorToCss(color) }
                      : undefined
                  }
                  disabled={!color}
                  onClick={() => {
                    if (color) {
                      commitActiveColor(color)
                    }
                  }}
                  aria-label={color ? `Use recent color ${index + 1}` : `Empty recent color slot ${index + 1}`}
                />
              )
            })}
          </div>
        </section>
      </aside>

      <main className="main-area">
        {pixelDocument ? (
          <div
            ref={viewportRef}
            className={`canvas-viewport ${activeTool === 'paint' || isColorPickerActive ? 'paint-cursor' : ''}`}
            onMouseDown={handleViewportMouseDown}
            onMouseMove={handleViewportMouseMove}
            onMouseLeave={handleViewportMouseLeave}
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
