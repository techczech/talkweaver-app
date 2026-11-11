import { createHash } from 'crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import sharp from 'sharp'
import { containedPoolFile } from './image-search/vault-pictures.ts'
import { imageMarksSvg, validateImageRecipe, type ImageEditRecipe, type ImageEditSource } from '../shared/image-edit.ts'

export const IMAGE_EDIT_RECIPE_MAX_BYTES = 100_000
export class ImageEditRecipeSizeError extends Error {
  constructor() { super('The edit recipe is too large. Remove some marks or shorten their labels, then try again.') }
}
function boundedRecipe(bytes: Buffer): Buffer {
  if (bytes.length > IMAGE_EDIT_RECIPE_MAX_BYTES) throw new ImageEditRecipeSizeError()
  return bytes
}

const ID = /^img-[0-9a-f]{7,64}$/
const EXTS = ['webp','png','jpg','jpeg','gif']
function sourceFile(root: string, id: string): string {
  if (!ID.test(id)) throw new Error('Choose a picture in this talk’s image pool.')
  const path = containedPoolFile(root, id, EXTS)
  if (!path) throw new Error('The original picture is unavailable. Restore it and try again.')
  return path
}
function recipePath(root: string, id: string): string { return join(root, '_assets', id + '.edit.json') }
export async function readImageEdit(root: string, id: string): Promise<ImageEditSource> {
  sourceFile(root, id)
  let originalId = id
  let recipe: ImageEditRecipe | null = null
  const path = recipePath(root,id)
  try {
    const st = lstatSync(path)
    if (!st.isFile() || st.size > IMAGE_EDIT_RECIPE_MAX_BYTES) throw new Error('The edit recipe cannot be read safely.')
    const saved = JSON.parse(boundedRecipe(readFileSync(path)).toString('utf8'))
    originalId = saved.originalId
    recipe = saved.recipe
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  const meta = await sharp(sourceFile(root, originalId), {limitInputPixels:40_000_000}).rotate().toBuffer({resolveWithObject:true})
  const {width,height} = meta.info
  return {originalId, width, height, recipe: recipe ? validateImageRecipe(recipe,width,height) : {version:1,crop:{x:0,y:0,width,height},marks:[]} }
}
/** Creates exclusively beside original. Vault authorization is rechecked after asynchronous rendering. */
export async function saveImageEdit(root: string, originalId: string, recipe: unknown, stillWritable: () => boolean, io: { write?: (fd: number, data: Buffer) => void } = {}): Promise<string> {
  const original = sourceFile(root,originalId)
  const pixels = await sharp(original,{limitInputPixels:40_000_000}).rotate().png().toBuffer({resolveWithObject:true})
  const {width,height} = pixels.info
  const valid = validateImageRecipe(recipe,width,height)
  const saved = boundedRecipe(Buffer.from(JSON.stringify({originalId,recipe:valid},null,2)+'\n','utf8'))
  const marked = await sharp(pixels.data).composite([{input:Buffer.from(imageMarksSvg(valid,width,height))}]).png().toBuffer()
  const data = await sharp(marked).extract({left:valid.crop.x,top:valid.crop.y,width:valid.crop.width,height:valid.crop.height}).png().toBuffer()
  // Include provenance: equal pixels from different originals must never share an edit recipe.
  const digest = createHash('sha256').update(data).update(saved).digest('hex')
  const pool = join(root,'_assets')
  const write = io.write ?? ((fd: number, bytes: Buffer) => writeFileSync(fd,bytes))
  const fail = (): Error => new Error('The edited copy could not be saved. Try again.')
  for (let attempt = 0; attempt < 1024; attempt++) {
    const hash = attempt === 0 ? digest : createHash('sha256').update(digest).update(String(attempt)).digest('hex')
    const id = 'img-'+hash.slice(0,7)
    if (!stillWritable() || sourceFile(root,originalId)!==original) throw new Error('The talk’s vault changed. Reopen the image and try again.')
    const image = join(pool,id+'.png'), recipeFile = recipePath(root,id)
    const occupied = readdirSync(pool).filter(name => (name.toLowerCase() === id || name.toLowerCase().startsWith(id+'.')))
    if (occupied.length) {
      // Reusing a complete, identical edit is read-only, not a reservation. No other ID occupant is allowed.
      if (occupied.length === 2 && occupied.includes(id+'.png') && occupied.includes(id+'.edit.json') &&
          lstatSync(image).isFile() && lstatSync(recipeFile).isFile() &&
          readFileSync(image).equals(data) && readFileSync(recipeFile).equals(saved)) return id
      continue
    }
    const created: Array<{ path: string; dev: number; ino: number }> = []
    const create = (path: string, bytes: Buffer): void => {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
      try {
        const st = fstatSync(fd)
        created.push({path,dev:st.dev,ino:st.ino})
        write(fd,bytes)
      } finally { closeSync(fd) }
    }
    const rollback = (): void => {
      for (const file of created.reverse()) {
        try {
          const st = lstatSync(file.path)
          if (st.dev === file.dev && st.ino === file.ino) unlinkSync(file.path)
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      }
    }
    try {
      // The PNG reserves the ID first. A recipe is never attached to an occupied image.
      create(image,data)
      if (readdirSync(pool).some(name => (name.toLowerCase() === id || name.toLowerCase().startsWith(id+'.')) && name !== id+'.png')) {
        rollback()
        continue
      }
      create(recipeFile,saved)
      return id
    } catch (e) {
      rollback()
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw fail()
    }
  }
  throw fail()
}
