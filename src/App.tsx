import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import './App.css'

type AssetFile = {
  key: string
  name: string
  url: string
}

type AssetModalMode = 'load' | 'save'

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
const SIDEBAR_RECENT_COLORS = 5
const COLOR_WHEEL_RECENT_COLORS = 24
const COLOR_WHEEL_SIZE = 240
const HUE_RING_THICKNESS = 28
const TRIANGLE_GAP = 12

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
const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

const hsvToRgb = (h: number, s: number, v: number): Color => {
  const hue = ((h % 360) + 360) % 360
  const saturation = clamp01(s)
  const value = clamp01(v)
  const chroma = value * saturation
  const huePrime = hue / 60
  const x = chroma * (1 - Math.abs((huePrime % 2) - 1))

  let red = 0
  let green = 0
  let blue = 0

  if (huePrime >= 0 && huePrime < 1) {
    red = chroma
    green = x
  } else if (huePrime >= 1 && huePrime < 2) {
    red = x
    green = chroma
  } else if (huePrime >= 2 && huePrime < 3) {
    green = chroma
    blue = x
  } else if (huePrime >= 3 && huePrime < 4) {
    green = x
    blue = chroma
  } else if (huePrime >= 4 && huePrime < 5) {
    red = x
    blue = chroma
  } else {
    red = chroma
    blue = x
  }

  const match = value - chroma

  return {
    r: clampColorChannel((red + match) * 255),
    g: clampColorChannel((green + match) * 255),
    b: clampColorChannel((blue + match) * 255),
    a: 255,
  }
}

const rgbToHsv = (r: number, g: number, b: number) => {
  const red = clampColorChannel(r) / 255
  const green = clampColorChannel(g) / 255
  const blue = clampColorChannel(b) / 255

  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min

  let hue = 0

  if (delta !== 0) {
    if (max === red) {
      hue = 60 * (((green - blue) / delta) % 6)
    } else if (max === green) {
      hue = 60 * ((blue - red) / delta + 2)
    } else {
      hue = 60 * ((red - green) / delta + 4)
    }
  }

  if (hue < 0) {
    hue += 360
  }

  const saturation = max === 0 ? 0 : delta / max
  const value = max

  return { h: hue, s: saturation, v: value }
}

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
  const [assetModalMode, setAssetModalMode] = useState<AssetModalMode | null>(null)
  const [currentPath, setCurrentPath] = useState<string[]>([])
  const [selectedAssetKey, setSelectedAssetKey] = useState<string | null>(null)
  const [savedAssets, setSavedAssets] = useState<AssetFile[]>([])
  const [saveFileName, setSaveFileName] = useState('')
  const [shouldSaveUpscaled, setShouldSaveUpscaled] = useState(false)
  const [upscaleFactor, setUpscaleFactor] = useState('32')
  const [saveErrorMessage, setSaveErrorMessage] = useState<string | null>(null)
  const [pixelDocument, setPixelDocument] = useState<PixelDocument | null>(null)
  const [activeTool, setActiveTool] = useState<Tool>('inspect')
  const [isColorPickerActive, setIsColorPickerActive] = useState(false)
  const [isColorWheelOpen, setIsColorWheelOpen] = useState(false)
  const [activeColor, setActiveColor] = useState<Color>({ r: 0, g: 0, b: 0, a: 255 })
  const [recentColors, setRecentColors] = useState<Color[]>([{ r: 0, g: 0, b: 0, a: 255 }])
  const [draftColor, setDraftColor] = useState<Color>({ r: 0, g: 0, b: 0, a: 255 })
  const [draftHsv, setDraftHsv] = useState(() => rgbToHsv(0, 0, 0))
  const [wheelDragMode, setWheelDragMode] = useState<'hue' | 'sv' | null>(null)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const colorWheelCanvasRef = useRef<HTMLCanvasElement | null>(null)
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
  const [historyPast, setHistoryPast] = useState<Uint8ClampedArray[]>([])
  const [historyFuture, setHistoryFuture] = useState<Uint8ClampedArray[]>([])
  const historyTransactionRef = useRef<{ before: Uint8ClampedArray; hasChanges: boolean } | null>(null)
  const saveRootDirectoryRef = useRef<FileSystemDirectoryHandle | null>(null)

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
      return [normalizedColor, ...deduped].slice(0, COLOR_WHEEL_RECENT_COLORS)
    })
  }, [])

  const cloneDocumentPixels = useCallback(() => {
    const document = pixelDocumentRef.current
    return document ? new Uint8ClampedArray(document.pixels) : null
  }, [])

  const beginHistoryStep = useCallback(() => {
    if (historyTransactionRef.current) {
      return
    }

    const before = cloneDocumentPixels()
    if (!before) {
      return
    }

    historyTransactionRef.current = {
      before,
      hasChanges: false,
    }
  }, [cloneDocumentPixels])

  const clearHistoryTransaction = useCallback(() => {
    historyTransactionRef.current = null
  }, [])

  const commitHistoryStep = useCallback(() => {
    const transaction = historyTransactionRef.current
    historyTransactionRef.current = null

    if (!transaction || !transaction.hasChanges) {
      return
    }

    setHistoryPast((previous) => [...previous, transaction.before])
    setHistoryFuture([])
  }, [])

  const applySnapshot = useCallback((snapshot: Uint8ClampedArray) => {
    const document = pixelDocumentRef.current

    if (!document) {
      return
    }

    document.pixels.set(snapshot)

    const documentContext = documentContextRef.current
    if (documentContext) {
      const imageData = new ImageData(new Uint8ClampedArray(snapshot), document.width, document.height)
      documentContext.putImageData(imageData, 0, 0)
    }

    setDocumentRenderVersion((version) => version + 1)
  }, [])

  const undoHistoryStep = useCallback(() => {
    const currentSnapshot = cloneDocumentPixels()
    if (!currentSnapshot) {
      return
    }

    setHistoryPast((previousPast) => {
      if (previousPast.length === 0) {
        return previousPast
      }

      const previousSnapshot = previousPast[previousPast.length - 1]
      setHistoryFuture((previousFuture) => [currentSnapshot, ...previousFuture])
      applySnapshot(previousSnapshot)
      return previousPast.slice(0, -1)
    })
  }, [applySnapshot, cloneDocumentPixels])

  const redoHistoryStep = useCallback(() => {
    const currentSnapshot = cloneDocumentPixels()
    if (!currentSnapshot) {
      return
    }

    setHistoryFuture((previousFuture) => {
      const nextSnapshot = previousFuture[0]
      if (!nextSnapshot) {
        return previousFuture
      }

      setHistoryPast((previousPast) => [...previousPast, currentSnapshot])
      applySnapshot(nextSnapshot)
      return previousFuture.slice(1)
    })
  }, [applySnapshot, cloneDocumentPixels])

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

    if (historyTransactionRef.current) {
      historyTransactionRef.current.hasChanges = true
    }

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
          return [activeColor, ...deduped].slice(0, COLOR_WHEEL_RECENT_COLORS)
        })
      }
    },
    [activeColor, setPixelColor],
  )

  const availableAssets = useMemo(() => [...assets, ...savedAssets], [savedAssets])

  const { directories, files } = useMemo(() => {
    const prefix = currentPath.length > 0 ? `${currentPath.join('/')}/` : ''
    const foundDirectories = new Set<string>()
    const foundFiles: AssetFile[] = []

    availableAssets.forEach((asset) => {
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
  }, [availableAssets, currentPath])

  const selectedAsset = useMemo(
    () => availableAssets.find((asset) => asset.key === selectedAssetKey) ?? null,
    [availableAssets, selectedAssetKey],
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
      commitHistoryStep()
      setPaintDragState({ isDrawing: false, lastPixelKey: null })
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [commitHistoryStep, drawPaintPixel, getPixelFromClientPoint, paintDragState.isDrawing])

  useEffect(() => {
    const handleHistoryHotkeys = (event: KeyboardEvent) => {
      const focusedElement = event.target as HTMLElement | null
      if (focusedElement && (focusedElement.tagName === 'INPUT' || focusedElement.tagName === 'TEXTAREA')) {
        return
      }

      if (!event.ctrlKey && !event.metaKey) {
        return
      }

      const key = event.key.toLowerCase()

      if (key === 'z' && !event.shiftKey) {
        event.preventDefault()
        undoHistoryStep()
        return
      }

      if (key === 'y' || (key === 'z' && event.shiftKey)) {
        event.preventDefault()
        redoHistoryStep()
      }
    }

    window.addEventListener('keydown', handleHistoryHotkeys)

    return () => {
      window.removeEventListener('keydown', handleHistoryHotkeys)
    }
  }, [redoHistoryStep, undoHistoryStep])

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
    setAssetModalMode('load')
    setCurrentPath([])
    setSelectedAssetKey(null)
  }

  const openSaveModal = () => {
    setAssetModalMode('save')
    setCurrentPath([])
    setSelectedAssetKey(null)
    setSaveFileName('')
    setShouldSaveUpscaled(false)
    setUpscaleFactor('32')
    setSaveErrorMessage(null)
  }

  const openSaveModal = () => {
    setAssetModalMode('save')
    setCurrentPath([])
    setSelectedAssetKey(null)
    setSaveFileName('')
    setShouldSaveUpscaled(false)
    setUpscaleFactor('32')
  }

  const closeAssetModal = () => {
    setAssetModalMode(null)
    setCurrentPath([])
    setSelectedAssetKey(null)
    setSaveErrorMessage(null)
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
    setHistoryPast([])
    setHistoryFuture([])
    clearHistoryTransaction()
    setHoverPixel(null)
    setPaintDragState({ isDrawing: false, lastPixelKey: null })
    closeAssetModal()
  }

  const buildDocumentPngCanvas = useCallback((pixelDoc: PixelDocument, scale: number) => {
    const baseCanvas = document.createElement('canvas')
    baseCanvas.width = pixelDoc.width
    baseCanvas.height = pixelDoc.height
    const baseContext = baseCanvas.getContext('2d')

    if (!baseContext) {
      throw new Error('Canvas context unavailable.')
    }

    const imageData = new ImageData(new Uint8ClampedArray(pixelDoc.pixels), pixelDoc.width, pixelDoc.height)
    baseContext.putImageData(imageData, 0, 0)

    if (scale <= 1) {
      return baseCanvas
    }

    const upscaledCanvas = document.createElement('canvas')
    upscaledCanvas.width = Math.max(1, pixelDoc.width * scale)
    upscaledCanvas.height = Math.max(1, pixelDoc.height * scale)
    const upscaledContext = upscaledCanvas.getContext('2d')

    if (!upscaledContext) {
      throw new Error('Canvas context unavailable.')
    }

    upscaledContext.imageSmoothingEnabled = false
    upscaledContext.drawImage(baseCanvas, 0, 0, upscaledCanvas.width, upscaledCanvas.height)
    return upscaledCanvas
  }, [])

  const buildCanvasBlob = useCallback(async (canvas: HTMLCanvasElement) => {
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), 'image/png')
    })

    if (!blob) {
      throw new Error('Failed to encode PNG file.')
    }

    return blob
  }, [])

  const resolveSaveRootDirectory = useCallback(async () => {
    const showDirectoryPicker = window.showDirectoryPicker

    if (!showDirectoryPicker) {
      throw new Error('This browser does not support direct folder saves.')
    }

    const existingHandle = saveRootDirectoryRef.current
    if (existingHandle) {
      const permission = existingHandle.queryPermission
        ? await existingHandle.queryPermission({ mode: 'readwrite' })
        : 'granted'
      if (permission === 'granted') {
        return existingHandle
      }

      const requestedPermission = existingHandle.requestPermission
        ? await existingHandle.requestPermission({ mode: 'readwrite' })
        : permission
      if (requestedPermission === 'granted') {
        return existingHandle
      }
    }

    const nextHandle = await showDirectoryPicker({
      mode: 'readwrite',
    })
    saveRootDirectoryRef.current = nextHandle
    return nextHandle
  }, [])

  const writeFileToDirectory = useCallback(
    async (rootDirectory: FileSystemDirectoryHandle, relativePath: string[], fileName: string, contents: Blob) => {
      let currentDirectory = rootDirectory

      for (const pathPart of relativePath) {
        currentDirectory = await currentDirectory.getDirectoryHandle(pathPart, { create: true })
      }

      const fileHandle = await currentDirectory.getFileHandle(fileName, { create: true })
      const writable = await fileHandle.createWritable()
      await writable.write(contents)
      await writable.close()
    },
    [],
  )

  const saveCurrentAsset = useCallback(async () => {
    if (!pixelDocument) {
      return
    }

    setSaveErrorMessage(null)

    const fallbackName = `asset_${new Date().toISOString().replace(/[:.]/g, '-')}`
    const normalizedName = saveFileName.trim().replace(/\.png$/i, '').replace(/[\\/:*?"<>|]/g, '_')
    const baseName = normalizedName.length > 0 ? normalizedName : fallbackName
    const keyPrefix = currentPath.length > 0 ? `${currentPath.join('/')}/` : ''

    try {
      const saveRootDirectory = await resolveSaveRootDirectory()
      const baseCanvas = buildDocumentPngCanvas(pixelDocument, 1)
      const baseBlob = await buildCanvasBlob(baseCanvas)
      await writeFileToDirectory(saveRootDirectory, currentPath, `${baseName}.png`, baseBlob)

      const nextAssets: AssetFile[] = [
        {
          key: `${keyPrefix}${baseName}.png`,
          name: `${baseName}.png`,
          url: URL.createObjectURL(baseBlob),
        },
      ]

      if (shouldSaveUpscaled) {
        const parsedFactor = Number.parseInt(upscaleFactor, 10)
        const safeFactor = Number.isFinite(parsedFactor) ? Math.max(1, parsedFactor) : 32
        const upscaleName = `${baseName}_upscaled_${safeFactor}x`
        const upscaledCanvas = buildDocumentPngCanvas(pixelDocument, safeFactor)
        const upscaledBlob = await buildCanvasBlob(upscaledCanvas)
        await writeFileToDirectory(saveRootDirectory, currentPath, `${upscaleName}.png`, upscaledBlob)
        nextAssets.push({
          key: `${keyPrefix}${upscaleName}.png`,
          name: `${upscaleName}.png`,
          url: URL.createObjectURL(upscaledBlob),
        })
      }

      setSavedAssets((previousAssets) => {
        const nextByKey = new Map(previousAssets.map((asset) => [asset.key, asset]))
        nextAssets.forEach((asset) => {
          nextByKey.set(asset.key, asset)
        })
        return Array.from(nextByKey.values()).sort((a, b) => a.key.localeCompare(b.key))
      })

      closeAssetModal()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save files.'
      setSaveErrorMessage(message)
    }
  }, [
    buildCanvasBlob,
    buildDocumentPngCanvas,
    closeAssetModal,
    currentPath,
    pixelDocument,
    resolveSaveRootDirectory,
    saveFileName,
    shouldSaveUpscaled,
    upscaleFactor,
    writeFileToDirectory,
  ])

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
      beginHistoryStep()
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
      clearHistoryTransaction()
    }
  }

  const canUndo = historyPast.length > 0
  const canRedo = historyFuture.length > 0

  const handleColorPickerClick = () => {
    setIsColorPickerActive((previousState) => !previousState)
  }

  const openColorWheel = () => {
    setDraftColor(activeColor)
    setDraftHsv(rgbToHsv(activeColor.r, activeColor.g, activeColor.b))
    setWheelDragMode(null)
    setIsColorWheelOpen(true)
  }

  const closeColorWheel = () => {
    setWheelDragMode(null)
    setIsColorWheelOpen(false)
  }

  const commitColorWheel = () => {
    commitActiveColor(draftColor)
    closeColorWheel()
  }

  const updateDraftFromHsv = useCallback((h: number, s: number, v: number) => {
    const normalizedHsv = {
      h: ((h % 360) + 360) % 360,
      s: clamp01(s),
      v: clamp01(v),
    }

    const rgb = hsvToRgb(normalizedHsv.h, normalizedHsv.s, normalizedHsv.v)
    setDraftHsv(normalizedHsv)
    setDraftColor(rgb)
  }, [])

  const updateDraftFromRgb = useCallback((r: number, g: number, b: number) => {
    const normalizedRgb = {
      r: clampColorChannel(r),
      g: clampColorChannel(g),
      b: clampColorChannel(b),
      a: 255,
    }

    setDraftColor(normalizedRgb)
    setDraftHsv(rgbToHsv(normalizedRgb.r, normalizedRgb.g, normalizedRgb.b))
  }, [])

  const readColorWheelSelection = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = colorWheelCanvasRef.current
      if (!canvas) {
        return null
      }

      const bounds = canvas.getBoundingClientRect()
      const localX = clientX - bounds.left
      const localY = clientY - bounds.top
      const center = COLOR_WHEEL_SIZE / 2
      const dx = localX - center
      const dy = localY - center
      const distance = Math.hypot(dx, dy)

      const outerRadius = COLOR_WHEEL_SIZE / 2 - 6
      const innerRadius = outerRadius - HUE_RING_THICKNESS

      if (distance <= outerRadius && distance >= innerRadius) {
        const angle = Math.atan2(dy, dx)
        const hue = ((angle * 180) / Math.PI + 360) % 360
        return { mode: 'hue' as const, h: hue, s: draftHsv.s, v: draftHsv.v }
      }

      const triangleRadius = innerRadius - TRIANGLE_GAP
      const top = { x: center, y: center - triangleRadius }
      const left = { x: center - triangleRadius * 0.8660254, y: center + triangleRadius / 2 }
      const right = { x: center + triangleRadius * 0.8660254, y: center + triangleRadius / 2 }

      const denominator = (left.y - right.y) * (top.x - right.x) + (right.x - left.x) * (top.y - right.y)
      if (denominator === 0) {
        return null
      }

      const w1 = ((left.y - right.y) * (localX - right.x) + (right.x - left.x) * (localY - right.y)) / denominator
      const w2 = ((right.y - top.y) * (localX - right.x) + (top.x - right.x) * (localY - right.y)) / denominator
      const w3 = 1 - w1 - w2

      const inTriangle = w1 >= -0.02 && w2 >= -0.02 && w3 >= -0.02
      if (!inTriangle) {
        return null
      }

      const clampedW1 = clamp01(w1)
      const clampedW2 = clamp01(w2)
      const clampedW3 = clamp01(w3)
      const total = Math.max(0.0001, clampedW1 + clampedW2 + clampedW3)

      const normalizedW1 = clampedW1 / total
      const normalizedW2 = clampedW2 / total
      const normalizedW3 = clampedW3 / total

      const value = clamp01(normalizedW1 + normalizedW2)
      const saturation = value > 0 ? clamp01(normalizedW1 / value) : 0

      return { mode: 'sv' as const, h: draftHsv.h, s: saturation, v: value }
    },
    [draftHsv.h, draftHsv.s, draftHsv.v],
  )

  const readHueFromPointer = useCallback((clientX: number, clientY: number) => {
    const canvas = colorWheelCanvasRef.current
    if (!canvas) {
      return null
    }

    const bounds = canvas.getBoundingClientRect()
    const localX = clientX - bounds.left
    const localY = clientY - bounds.top
    const center = COLOR_WHEEL_SIZE / 2
    const dx = localX - center
    const dy = localY - center

    if (dx === 0 && dy === 0) {
      return null
    }

    return ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360
  }, [])

  const handleColorWheelMouseDown = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const nextSelection = readColorWheelSelection(event.clientX, event.clientY)
    if (!nextSelection) {
      return
    }

    updateDraftFromHsv(nextSelection.h, nextSelection.s, nextSelection.v)
    setWheelDragMode(nextSelection.mode)
  }

  useEffect(() => {
    if (!wheelDragMode) {
      return
    }

    const handleWindowMove = (event: MouseEvent) => {
      if (wheelDragMode === 'hue') {
        const nextHue = readHueFromPointer(event.clientX, event.clientY)
        if (nextHue === null) {
          return
        }

        updateDraftFromHsv(nextHue, draftHsv.s, draftHsv.v)
        return
      }

      const nextSelection = readColorWheelSelection(event.clientX, event.clientY)
      if (!nextSelection || nextSelection.mode !== 'sv') {
        return
      }

      updateDraftFromHsv(draftHsv.h, nextSelection.s, nextSelection.v)
    }

    const handleWindowUp = () => {
      setWheelDragMode(null)
    }

    window.addEventListener('mousemove', handleWindowMove)
    window.addEventListener('mouseup', handleWindowUp)

    return () => {
      window.removeEventListener('mousemove', handleWindowMove)
      window.removeEventListener('mouseup', handleWindowUp)
    }
  }, [draftHsv.h, draftHsv.s, draftHsv.v, readColorWheelSelection, readHueFromPointer, updateDraftFromHsv, wheelDragMode])

  useEffect(() => {
    if (!isColorWheelOpen) {
      return
    }

    const canvas = colorWheelCanvasRef.current
    if (!canvas) {
      return
    }

    canvas.width = COLOR_WHEEL_SIZE
    canvas.height = COLOR_WHEEL_SIZE

    const context = canvas.getContext('2d')
    if (!context) {
      return
    }

    const center = COLOR_WHEEL_SIZE / 2
    const outerRadius = COLOR_WHEEL_SIZE / 2 - 6
    const innerRadius = outerRadius - HUE_RING_THICKNESS

    context.clearRect(0, 0, COLOR_WHEEL_SIZE, COLOR_WHEEL_SIZE)

    const triangleRadius = innerRadius - TRIANGLE_GAP
    const top = { x: center, y: center - triangleRadius }
    const left = { x: center - triangleRadius * 0.8660254, y: center + triangleRadius / 2 }
    const right = { x: center + triangleRadius * 0.8660254, y: center + triangleRadius / 2 }

    const imageData = context.createImageData(COLOR_WHEEL_SIZE, COLOR_WHEEL_SIZE)
    const pixels = imageData.data

    const denominator = (left.y - right.y) * (top.x - right.x) + (right.x - left.x) * (top.y - right.y)

    for (let y = 0; y < COLOR_WHEEL_SIZE; y += 1) {
      for (let x = 0; x < COLOR_WHEEL_SIZE; x += 1) {
        const w1 = ((left.y - right.y) * (x - right.x) + (right.x - left.x) * (y - right.y)) / denominator
        const w2 = ((right.y - top.y) * (x - right.x) + (top.x - right.x) * (y - right.y)) / denominator
        const w3 = 1 - w1 - w2

        if (w1 < 0 || w2 < 0 || w3 < 0) {
          continue
        }

        const value = clamp01(w1 + w2)
        const saturation = value > 0 ? clamp01(w1 / value) : 0
        const rgb = hsvToRgb(draftHsv.h, saturation, value)
        const index = (y * COLOR_WHEEL_SIZE + x) * 4
        pixels[index] = rgb.r
        pixels[index + 1] = rgb.g
        pixels[index + 2] = rgb.b
        pixels[index + 3] = 255
      }
    }

    context.putImageData(imageData, 0, 0)

    for (let degrees = 0; degrees < 360; degrees += 1) {
      const start = (degrees * Math.PI) / 180
      const end = ((degrees + 1) * Math.PI) / 180
      context.beginPath()
      context.arc(center, center, outerRadius, start, end)
      context.arc(center, center, innerRadius, end, start, true)
      context.closePath()
      context.fillStyle = `hsl(${degrees}, 100%, 50%)`
      context.fill()
    }

    context.strokeStyle = '#11151f'
    context.lineWidth = 1
    context.beginPath()
    context.moveTo(top.x, top.y)
    context.lineTo(right.x, right.y)
    context.lineTo(left.x, left.y)
    context.closePath()
    context.stroke()

    const hueRadians = (draftHsv.h * Math.PI) / 180
    const hueRadius = (innerRadius + outerRadius) / 2
    const huePointer = {
      x: center + Math.cos(hueRadians) * hueRadius,
      y: center + Math.sin(hueRadians) * hueRadius,
    }

    const value = draftHsv.v
    const saturation = draftHsv.s
    const w1 = saturation * value
    const w2 = value - w1
    const w3 = 1 - value
    const svPointer = {
      x: top.x * w1 + left.x * w2 + right.x * w3,
      y: top.y * w1 + left.y * w2 + right.y * w3,
    }

    context.fillStyle = '#ffffff'
    context.strokeStyle = '#141820'
    context.lineWidth = 2
    context.beginPath()
    context.arc(huePointer.x, huePointer.y, 5, 0, Math.PI * 2)
    context.fill()
    context.stroke()

    context.beginPath()
    context.arc(svPointer.x, svPointer.y, 5, 0, Math.PI * 2)
    context.fill()
    context.stroke()
  }, [draftHsv.h, draftHsv.s, draftHsv.v, isColorWheelOpen])

  const directoryPathLabel = currentPath.length > 0 ? `/${currentPath.join('/')}` : '/'

  return (
    <div className="app-frame">
      <aside className="sidebar">
        <button className="load-asset-button" onClick={openAssetModal}>
          Load Asset
        </button>

        <section className="tools-section">
          <h3 className="tools-title">History</h3>
          <div className="history-row">
            <button className="tool-button" onClick={undoHistoryStep} disabled={!canUndo}>
              Undo
            </button>
            <button className="tool-button" onClick={redoHistoryStep} disabled={!canRedo}>
              Redo
            </button>
          </div>
        </section>

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
            <button className="tool-button" onClick={openColorWheel}>
              Color Wheel
            </button>
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
            {Array.from({ length: SIDEBAR_RECENT_COLORS }).map((_, index) => {
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

        <button className="load-asset-button save-button" onClick={openSaveModal} disabled={!pixelDocument}>
          Save
        </button>
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

      {assetModalMode ? (
        <div className="modal-overlay">
          <div className="modal-window">
            <div className="modal-header-row">
              <h2 className="modal-title">{assetModalMode === 'load' ? 'Load Asset' : 'Save Asset'}</h2>
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

              {files.map((file) =>
                assetModalMode === 'load' ? (
                  <button
                    key={file.key}
                    className={`file-preview-button ${selectedAssetKey === file.key ? 'selected' : ''}`}
                    onClick={() => setSelectedAssetKey(file.key)}
                  >
                    <img src={file.url} alt={file.name} className="file-thumbnail" />
                    <span className="file-name-label">{file.name}</span>
                  </button>
                ) : (
                  <div key={file.key} className="file-preview-button existing-file-card">
                    <img src={file.url} alt={file.name} className="file-thumbnail" />
                    <span className="file-name-label">{file.name}</span>
                  </div>
                ),
              )}

              {directories.length === 0 && files.length === 0 ? (
                <p className="empty-state-text">No PNG assets in this folder.</p>
              ) : null}
            </div>

            <div className="modal-footer">
              {assetModalMode === 'save' ? (
                <div className="save-controls-row">
                  <input
                    className="save-filename-input"
                    placeholder="File name"
                    value={saveFileName}
                    onChange={(event) => setSaveFileName(event.target.value)}
                  />
                  <label className="upscale-option">
                    <input
                      type="checkbox"
                      checked={shouldSaveUpscaled}
                      onChange={(event) => setShouldSaveUpscaled(event.target.checked)}
                    />
                    Include Upscale by
                    <input
                      className="upscale-factor-input"
                      type="number"
                      min={1}
                      step={1}
                      value={upscaleFactor}
                      disabled={!shouldSaveUpscaled}
                      onChange={(event) => setUpscaleFactor(event.target.value)}
                    />
                  </label>
                </div>
              ) : null}
              {assetModalMode === 'save' && saveErrorMessage ? (
                <p className="save-error-text" role="alert">
                  {saveErrorMessage}
                </p>
              ) : null}
              <button className="cancel-button" onClick={closeAssetModal}>
                Cancel
              </button>
              {assetModalMode === 'load' ? (
                <button
                  className={`confirm-load-button ${selectedAsset ? 'enabled' : ''}`}
                  onClick={loadSelectedAsset}
                  disabled={!selectedAsset}
                >
                  Load
                </button>
              ) : (
                <button className="confirm-load-button enabled" onClick={saveCurrentAsset}>
                  Save
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {isColorWheelOpen ? (
        <div className="modal-overlay">
          <div className="color-wheel-modal-window">
            <h2 className="modal-title">Choose a Color</h2>

            <div className="color-wheel-layout">
              <div className="color-wheel-left-panel">
                <canvas
                  ref={colorWheelCanvasRef}
                  className="color-wheel-canvas"
                  onMouseDown={handleColorWheelMouseDown}
                  aria-label="HSV color wheel"
                />
                <div className="color-preview-strip" style={{ backgroundColor: colorToCss(draftColor) }} />
              </div>

              <div className="color-wheel-right-panel">
                <div className="channel-grid">
                  <label className="channel-row">
                    <span>R</span>
                    <input
                      type="number"
                      min={0}
                      max={255}
                      value={draftColor.r}
                      onChange={(event) => updateDraftFromRgb(Number(event.target.value), draftColor.g, draftColor.b)}
                    />
                  </label>
                  <label className="channel-row">
                    <span>G</span>
                    <input
                      type="number"
                      min={0}
                      max={255}
                      value={draftColor.g}
                      onChange={(event) => updateDraftFromRgb(draftColor.r, Number(event.target.value), draftColor.b)}
                    />
                  </label>
                  <label className="channel-row">
                    <span>B</span>
                    <input
                      type="number"
                      min={0}
                      max={255}
                      value={draftColor.b}
                      onChange={(event) => updateDraftFromRgb(draftColor.r, draftColor.g, Number(event.target.value))}
                    />
                  </label>
                  <label className="channel-row">
                    <span>H</span>
                    <input
                      type="number"
                      min={0}
                      max={360}
                      value={Math.round(draftHsv.h)}
                      onChange={(event) => updateDraftFromHsv(Number(event.target.value), draftHsv.s, draftHsv.v)}
                    />
                  </label>
                  <label className="channel-row">
                    <span>S</span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={Math.round(draftHsv.s * 100)}
                      onChange={(event) =>
                        updateDraftFromHsv(draftHsv.h, Number(event.target.value) / 100, draftHsv.v)
                      }
                    />
                  </label>
                  <label className="channel-row">
                    <span>V</span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={Math.round(draftHsv.v * 100)}
                      onChange={(event) =>
                        updateDraftFromHsv(draftHsv.h, draftHsv.s, Number(event.target.value) / 100)
                      }
                    />
                  </label>
                </div>

                <section className="expanded-recent-list">
                  <h3 className="tools-title">Recent Colors</h3>
                  <div className="expanded-recent-grid">
                    {recentColors.map((color, index) => (
                      <button
                        key={`${colorToKey(color)}-${index}`}
                        className={`recent-color-swatch ${areColorsEqual(color, draftColor) ? 'active' : ''}`}
                        style={{ backgroundColor: colorToCss(color) }}
                        onClick={() => {
                          setDraftColor(color)
                          setDraftHsv(rgbToHsv(color.r, color.g, color.b))
                        }}
                        aria-label={`Use recent color ${index + 1}`}
                      />
                    ))}
                  </div>
                </section>
              </div>
            </div>

            <div className="modal-footer">
              <button className="cancel-button" onClick={closeColorWheel}>
                Cancel
              </button>
              <button className="confirm-load-button enabled" onClick={commitColorWheel}>
                Confirm
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default App
