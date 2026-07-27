export async function traverseFileTree(items: DataTransferItemList, relativePath: string, result: File[]): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const entry = item.webkitGetAsEntry?.();
    if (!entry) {
      const file = item.getAsFile();
      if (file) {
        (file as any)._relativePath = relativePath;
        result.push(file);
      }
      continue;
    }
    if (entry.isFile) {
      const file = await new Promise<File>((resolve) => {
        (entry as FileSystemFileEntry).file((f) => {
          (f as any)._relativePath = relativePath;
          resolve(f);
        });
      });
      result.push(file);
    } else if (entry.isDirectory) {
      const dirReader = (entry as FileSystemDirectoryEntry).createReader();
      const entries = await new Promise<FileSystemEntry[]>((resolve) => {
        dirReader.readEntries(resolve);
      });
      const subPath = relativePath ? `${relativePath}\\${entry.name}` : entry.name;
      for (const subEntry of entries) {
        await traverseEntry(subEntry, subPath, result);
      }
    }
  }
}

async function traverseEntry(entry: FileSystemEntry, relativePath: string, result: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve) => {
      (entry as FileSystemFileEntry).file((f) => {
        (f as any)._relativePath = relativePath;
        resolve(f);
      });
    });
    result.push(file);
  } else if (entry.isDirectory) {
    const dirReader = (entry as FileSystemDirectoryEntry).createReader();
    const getEntries = (): Promise<FileSystemEntry[]> => new Promise((resolve) => {
      const all: FileSystemEntry[] = [];
      const readBatch = () => {
        dirReader.readEntries((batch) => {
          if (batch.length === 0) { resolve(all); return; }
          all.push(...batch);
          readBatch();
        });
      };
      readBatch();
    });
    const entries = await getEntries();
    const subPath = relativePath ? `${relativePath}\\${entry.name}` : entry.name;
    for (const subEntry of entries) {
      await traverseEntry(subEntry, subPath, result);
    }
  }
}
