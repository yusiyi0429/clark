import React from 'react';
import {m2VersionLabel,m2VersionDetails} from './build-version.mjs';
// This constant is embedded in app.js. An old cached bundle keeps its own build identity.
const info=typeof __M2_BUILD_INFO__==='undefined'?{}:__M2_BUILD_INFO__;
export default function M2BuildVersion(){
 return <footer className="m2-build-version" aria-label="M2 前端版本"><small title={m2VersionDetails(info)}>{m2VersionLabel(info,globalThis.location?.hostname||'')}</small></footer>;
}
