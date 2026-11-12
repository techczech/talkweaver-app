"""Production liveness only; no debugger, owner profile or foreground window."""
import pathlib,subprocess,tempfile,os,time,json,signal,ctypes
root=pathlib.Path(__file__).resolve().parent.parent
exe=root/'release/mac-arm64/TalkWeaver.app/Contents/MacOS/TalkWeaver'
with tempfile.TemporaryDirectory(prefix='.alpha-hidden-',dir=root) as scratch:
 data=pathlib.Path(scratch)/'profile';data.mkdir()
 vault=pathlib.Path(scratch)/'vault';talk=vault/'fixture';talk.mkdir(parents=True)
 (talk/'fixture-outline.md').write_text('---\ntitle: Alpha smoke fixture\n---\n\n## Talk\n\n### Opening {id=opening}\n\nPublic fixture text.\n')
 (data/'config.json').write_text(json.dumps({'vaultRoot':str(vault)}))
 env={**os.environ,'TW_E2E':'1'}
 env.pop('ELECTRON_RUN_AS_NODE',None)
 with (root/'evidence/alpha-0440-1/hidden-runtime-app.log').open('w') as log:
  proc=subprocess.Popen([str(exe),'--user-data-dir='+str(data),'--use-mock-keychain','--use-fake-device-for-media-stream','--force-renderer-accessibility','--use-file-for-fake-audio-capture='+str(root/'docs/design/2026-11-10-record-and-edit-video/built/slice-2/fixtures/human-english.wav')],env=env,cwd=root,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  try:
   time.sleep(15)
   assert proc.poll() is None,'Packaged runtime exited during startup'
   print('PASS hidden production runtime alive after 15 seconds; isolated fixture vault/profile; no interactive recording proof',flush=True)
   # Read only this owned process. No AX action, focus or permission-prompt request.
   ax=ctypes.CDLL('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
   cf=ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
   ptr=ctypes.c_void_p
   ax.AXUIElementCreateApplication.argtypes=[ctypes.c_int];ax.AXUIElementCreateApplication.restype=ptr
   ax.AXUIElementSetMessagingTimeout.argtypes=[ptr,ctypes.c_float];ax.AXUIElementSetMessagingTimeout.restype=ctypes.c_int
   ax.AXUIElementCopyAttributeValue.argtypes=[ptr,ptr,ctypes.POINTER(ptr)];ax.AXUIElementCopyAttributeValue.restype=ctypes.c_int
   cf.CFStringCreateWithCString.argtypes=[ptr,ctypes.c_char_p,ctypes.c_uint32];cf.CFStringCreateWithCString.restype=ptr
   cf.CFArrayGetCount.argtypes=[ptr];cf.CFArrayGetCount.restype=ctypes.c_long
   cf.CFGetTypeID.argtypes=[ptr];cf.CFGetTypeID.restype=ctypes.c_ulong
   cf.CFArrayGetTypeID.restype=ctypes.c_ulong
   cf.CFRelease.argtypes=[ptr]
   element=ax.AXUIElementCreateApplication(proc.pid);attribute=cf.CFStringCreateWithCString(None,b'AXWindows',0x08000100);windows=ptr()
   try:
    ax.AXUIElementSetMessagingTimeout(element,0.5)
    error=ax.AXUIElementCopyAttributeValue(element,attribute,ctypes.byref(windows))
    count=cf.CFArrayGetCount(windows) if not error and windows.value and cf.CFGetTypeID(windows)==cf.CFArrayGetTypeID() else None
    record={'pid':proc.pid,'AXWindowsError':error,'hiddenWindowCount':count,'actionsPerformed':False}
    (root/'evidence/alpha-0440-1/packaged-hidden-accessibility.json').write_text(json.dumps(record,indent=2)+'\n')
    print(json.dumps(record),flush=True)
   finally:
    if windows.value:cf.CFRelease(windows)
    cf.CFRelease(attribute);cf.CFRelease(element)
  finally:
   if proc.poll() is None:
    os.killpg(proc.pid,signal.SIGTERM)
    try:proc.wait(timeout=15)
    except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait()
