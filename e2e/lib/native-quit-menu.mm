#import <Cocoa/Cocoa.h>
#include <node_api.h>
#include <unistd.h>
#include <string>
static napi_value ClickQuit(napi_env env, napi_callback_info info) {
  size_t argc=2; napi_value args[2]; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  int32_t pid=0; size_t size=0;
  if(argc!=2 || napi_get_value_int32(env,args[0],&pid)!=napi_ok || pid!=getpid() || ![NSThread isMainThread]) {
    napi_throw_error(env,nullptr,"native menu click refused: PID or UI thread mismatch"); return nullptr;
  }
  napi_get_value_string_utf8(env,args[1],nullptr,0,&size); std::string label(size+1,'\0');
  napi_get_value_string_utf8(env,args[1],label.data(),label.size(),&size); label.resize(size);
  NSString *wanted=[NSString stringWithUTF8String:label.c_str()]; NSMenu *found=nil; NSInteger index=-1;
  for(NSMenuItem *top in [[NSApp mainMenu] itemArray]) {
    NSMenu *sub=[top submenu];
    for(NSInteger i=0;i<[sub numberOfItems];i++) {
      NSMenuItem *item=[sub itemAtIndex:i];
      if([[item title] isEqualToString:wanted] && [item action]==@selector(terminate:)) {
        if(found || ![item isEnabled]) { napi_throw_error(env,nullptr,"native Quit item ambiguous or disabled");return nullptr; }
        found=sub;index=i;
      }
    }
  }
  if(!found) { napi_throw_error(env,nullptr,"native application Quit item not found");return nullptr; }
  // Run the selected real NSMenu item, inside this test app's process, after the inspector reply.
  dispatch_async(dispatch_get_main_queue(), ^{ [found performActionForItemAtIndex:index]; });
  napi_value result;napi_create_string_utf8(env,[wanted UTF8String],NAPI_AUTO_LENGTH,&result);return result;
}
static napi_value Init(napi_env env,napi_value exports) {
  napi_value fn;napi_create_function(env,"clickQuit",NAPI_AUTO_LENGTH,ClickQuit,nullptr,&fn);
  napi_set_named_property(env,exports,"clickQuit",fn);return exports;
}
NAPI_MODULE(native_menu,Init)
