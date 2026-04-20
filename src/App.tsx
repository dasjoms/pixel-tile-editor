import { useMemo, useState } from 'react'
import './App.css'

type AssetFile = {
  key: string
  name: string
  url: string
}

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

const App = () => {
  const [isAssetModalOpen, setIsAssetModalOpen] = useState(false)
  const [currentPath, setCurrentPath] = useState<string[]>([])
  const [selectedAssetKey, setSelectedAssetKey] = useState<string | null>(null)
  const [loadedAssetUrl, setLoadedAssetUrl] = useState<string | null>(null)

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

  const loadSelectedAsset = () => {
    if (!selectedAsset) {
      return
    }

    setLoadedAssetUrl(selectedAsset.url)
    closeAssetModal()
  }

  const directoryPathLabel = currentPath.length > 0 ? `/${currentPath.join('/')}` : '/'

  return (
    <div className="app-frame">
      <aside className="sidebar">
        <button className="load-asset-button" onClick={openAssetModal}>
          Load Asset
        </button>
      </aside>

      <main className="main-area">
        {loadedAssetUrl ? (
          <img src={loadedAssetUrl} alt="Loaded tile asset" className="loaded-asset-preview" />
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
