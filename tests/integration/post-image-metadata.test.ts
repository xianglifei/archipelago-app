import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { POST_DDL, toPostLetter, type PostLetterRow } from '../../src/shared/post-core'
const native = vi.hoisted(()=>({createFromBuffer:vi.fn()}))
vi.mock('electron',()=>({nativeImage:native}))
import { postalImageMime, postalImageThumb } from '../../src/main/post-images'
describe('postal display thumbnail and persisted attachment contract',()=>{
 it('creates a bounded display thumbnail without changing input bytes',()=>{
  const jpeg=vi.fn(()=>Buffer.from('display-preview'));const resize=vi.fn(()=>({toJPEG:jpeg}))
  native.createFromBuffer.mockReturnValue({isEmpty:()=>false,getSize:()=>({width:1254,height:1254}),resize})
  const original=Buffer.from('original postal bytes');const before=Buffer.from(original);const thumb=postalImageThumb(original)
  expect(resize).toHaveBeenCalledWith({width:320,quality:'good'});expect(original).toEqual(before)
  expect(thumb).toBe('data:image/jpeg;base64,ZGlzcGxheS1wcmV2aWV3')
 })
 it('keeps a portrait proportional and safely falls back for unsupported bytes',()=>{
  const resize=vi.fn(()=>({toJPEG:()=>Buffer.from('preview')}));native.createFromBuffer.mockReturnValue({isEmpty:()=>false,getSize:()=>({width:600,height:1200}),resize})
  postalImageThumb(Buffer.from('portrait'));expect(resize).toHaveBeenCalledWith({height:320,quality:'good'})
  native.createFromBuffer.mockReturnValue({isEmpty:()=>true});expect(postalImageThumb(Buffer.from('invalid'))).toBeUndefined()
 })
 it('reopens the formal image metadata through the real local letter mapper',()=>{
  const db=new Database(':memory:');db.exec(POST_DDL)
  const attachments=[{id:'att',filename:'photo.png',size:123,mime:postalImageMime('photo.png'),localPath:'/synthetic/photo.png',thumb:'data:image/jpeg;base64,cHJldmlldw=='}]
  db.prepare("INSERT INTO post_letters(id,direction,peer_island,peer_name,kind,body,attachments,status,created_at) VALUES('id','out','peer','小舟 · 灯塔岛','letter','hello',?,'sent',1)").run(JSON.stringify(attachments))
  const reopened=toPostLetter(db.prepare('SELECT * FROM post_letters').get() as PostLetterRow)
  expect(reopened.attachments).toEqual(attachments);expect(reopened.body).toBe('hello');expect(reopened.status).toBe('sent')
 })
})
