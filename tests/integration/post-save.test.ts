import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dialog=vi.hoisted(()=>({showSaveDialog:vi.fn()}))
vi.mock('electron',()=>({dialog}))
vi.mock('../../src/main/ui-strings',()=>({uiStr:(key:string)=>key}))
import { postSaveInviteQr } from '../../src/main/post-save'
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')
const url='data:image/png;base64,'+png.toString('base64')
const directories:string[]=[]
const temp=()=>{const d=mkdtempSync(join(tmpdir(),'postal-save-test-'));directories.push(d);return d}
afterEach(()=>{for(const d of directories.splice(0))rmSync(d,{recursive:true,force:true});dialog.showSaveDialog.mockReset()})
describe('real save-result contract with an isolated native dialog substitute',()=>{
 it('writes exact QR PNG bytes before returning saved',async()=>{
  const path=join(temp(),'invite.png');dialog.showSaveDialog.mockResolvedValue({canceled:false,filePath:path})
  expect(await postSaveInviteQr(url)).toEqual({saved:true});expect(readFileSync(path)).toEqual(png)
 })
 it('cancel does not create a file or report success',async()=>{
  const d=temp();dialog.showSaveDialog.mockResolvedValue({canceled:true})
  expect(await postSaveInviteQr(url)).toEqual({saved:false});expect(readdirSync(d)).toEqual([])
 })
 it('propagates a save failure without a success result',async()=>{
  dialog.showSaveDialog.mockResolvedValue({canceled:false,filePath:join(temp(),'missing','invite.png')})
  await expect(postSaveInviteQr(url)).rejects.toThrow('postSaveQrFailed')
 })
 it('rejects non-PNG and oversized payloads before opening a dialog',async()=>{
  await expect(postSaveInviteQr('data:text/plain;base64,eA==')).rejects.toThrow()
  await expect(postSaveInviteQr('data:image/png;base64,'+'A'.repeat(1024*1024))).rejects.toThrow()
  expect(dialog.showSaveDialog).not.toHaveBeenCalled()
 })
})
