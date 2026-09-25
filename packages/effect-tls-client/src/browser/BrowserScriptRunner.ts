interface RunnerLimits {
  readonly maxInputLineBytes: number;
  readonly maxControlInputLineBytes: number;
  readonly maxOutputLineBytes: number;
  readonly maxOutputBytes: number;
  readonly maxCookieBytes: number;
  readonly maxCookieWrites: number;
  readonly maxNetworkRequests: number;
  readonly maxRequestBodyBytes: number;
  readonly maxTotalNetworkBytes: number;
  readonly maxHeaders: number;
  readonly maxHeaderBytes: number;
  readonly maxTimers: number;
  readonly maxTimerDelayMs: number;
}

export const makeBrowserScriptRunnerSource = (limits: RunnerLimits): string => {
  const bootstrap = String.raw`
(() => {
  const post = __post;
  // Host helpers exchange only primitives; no host objects enter the VM.
  const hostRandomBytes = __randomBytes;
  const hostEncodeBlobText = __encodeBlobText;
  const hostDecodeBlobText = __decodeBlobText;
  const NativeUint8Array = Uint8Array;
  const NativeArrayBuffer = ArrayBuffer;
  const NativePromise = Promise;
  const NativeError = Error;
  const NativeTypeError = TypeError;
  const NativeString = String;
  const NativeNumber = Number;
  const mathTrunc = Math.trunc;
  const apply = Reflect.apply;
  const isView = NativeArrayBuffer.isView;
  const typedArrayPrototype = Object.getPrototypeOf(NativeUint8Array.prototype);
  const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag).get;
  const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer").get;
  const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset").get;
  const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength").get;
  const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, "buffer").get;
  const dataViewByteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, "byteOffset").get;
  const dataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength").get;
  const arrayBufferByteLength = Object.getOwnPropertyDescriptor(NativeArrayBuffer.prototype, "byteLength").get;
  const stringCharCodeAt = String.prototype.charCodeAt;
  const stringFromCharCode = String.fromCharCode;
  const numberToString = Number.prototype.toString;
  const getRandomValues = (array) => {
    if (!isView(array)) throw new NativeTypeError("crypto.getRandomValues expects an integer typed array");
    const tag = apply(typedArrayTag, array, []);
    if (tag !== "Int8Array" && tag !== "Uint8Array" && tag !== "Uint8ClampedArray" &&
        tag !== "Int16Array" && tag !== "Uint16Array" && tag !== "Int32Array" &&
        tag !== "Uint32Array" && tag !== "BigInt64Array" && tag !== "BigUint64Array") {
      throw new NativeTypeError("crypto.getRandomValues expects an integer typed array");
    }
    const byteLength = apply(typedArrayByteLength, array, []);
    if (byteLength > 65536) {
      const error = new NativeError("The requested length exceeds 65,536 bytes");
      error.name = "QuotaExceededError";
      throw error;
    }
    const buffer = apply(typedArrayBuffer, array, []);
    const byteOffset = apply(typedArrayByteOffset, array, []);
    const destination = new NativeUint8Array(buffer, byteOffset, byteLength);
    const bytes = hostRandomBytes(byteLength);
    if (typeof bytes !== "string" || bytes.length !== byteLength) {
      throw new NativeError("secure random source failed");
    }
    for (let index = 0; index < byteLength; index += 1) {
      destination[index] = apply(stringCharCodeAt, bytes, [index]);
    }
    return array;
  };
  const crypto = Object.freeze({ getRandomValues });
  // Keep the host clock closure private; only the local wrapper is script-visible.
  const monotonicNow = __performanceNow;
  const performance = Object.freeze({
    timeOrigin: Number(__performanceTimeOrigin),
    now: () => monotonicNow(),
  });
  const initialUrl = String(__pageUrl);
  const userAgent = String(__userAgent);
  const authoritativeCookies = Boolean(__authoritativeCookies);
  const MAX_REQUEST_BODY_BYTES = ${limits.maxRequestBodyBytes};
  const MAX_NETWORK_REQUESTS = ${limits.maxNetworkRequests};
  const MAX_TOTAL_NETWORK_BYTES = ${limits.maxTotalNetworkBytes};
  const MAX_OUTPUT_LINE_BYTES = ${limits.maxOutputLineBytes};
  const MAX_OUTPUT_BYTES = ${limits.maxOutputBytes};
  const MAX_HEADERS = ${limits.maxHeaders};
  const MAX_HEADER_BYTES = ${limits.maxHeaderBytes};
  const utf8Length = (value) => {
    const text = String(value);
    let bytes = 0;
    for (let index = 0; index < text.length; index += 1) {
      const code = apply(stringCharCodeAt, text, [index]);
      if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && apply(stringCharCodeAt, text, [index + 1]) >= 0xdc00 && apply(stringCharCodeAt, text, [index + 1]) <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    }
    return bytes;
  };
  const MAX_BLOB_BYTES = 1024 * 1024;
  const blobData = new WeakMap();
  let blobBytesAllocated = 0;
  const blobQuotaError = () => {
    const error = new NativeError("Blob allocation exceeds the 1 MiB per-evaluation quota");
    error.name = "QuotaExceededError";
    return error;
  };
  const reserveBlobBytes = (size) => {
    if (size < 0 || blobBytesAllocated + size > MAX_BLOB_BYTES) throw blobQuotaError();
    blobBytesAllocated += size;
  };
  const normalizeBlobType = (value) => {
    const text = value === undefined ? "" : NativeString(value);
    for (let index = 0; index < text.length; index += 1) {
      const code = apply(stringCharCodeAt, text, [index]);
      if (code < 0x20 || code > 0x7e) return "";
    }
    reserveBlobBytes(text.length);
    let result = "";
    for (let index = 0; index < text.length; index += 1) {
      const code = apply(stringCharCodeAt, text, [index]);
      result += stringFromCharCode(code >= 0x41 && code <= 0x5a ? code + 0x20 : code);
    }
    return result;
  };
  const copyBlobRange = (buffer, byteOffset, byteLength) => {
    reserveBlobBytes(byteLength);
    const source = new NativeUint8Array(buffer, byteOffset, byteLength);
    const copy = new NativeUint8Array(byteLength);
    for (let index = 0; index < byteLength; index += 1) copy[index] = source[index];
    return copy;
  };
  const getBlobData = (value) => {
    const data = blobData.get(value);
    if (data === undefined) throw new NativeTypeError("Blob method called on an incompatible receiver");
    return data;
  };
  const relativeBlobIndex = (value, size) => {
    const number = NativeNumber(value);
    const integer = number !== number || number === 0 ? 0 : mathTrunc(number);
    const index = integer < 0 ? size + integer : integer;
    return index < 0 ? 0 : index > size ? size : index;
  };
  const blobByteString = (data) => {
    let result = "";
    for (let index = data.start; index < data.end; index += 1) {
      result += stringFromCharCode(data.bytes[index]);
    }
    return result;
  };
  const copyBlobBytes = (data) => {
    const size = data.end - data.start;
    reserveBlobBytes(size);
    const bytes = new NativeUint8Array(size);
    for (let index = 0; index < size; index += 1) bytes[index] = data.bytes[data.start + index];
    return bytes;
  };
  const decodeBlobText = (data) => {
    reserveBlobBytes(data.end - data.start);
    const text = hostDecodeBlobText(blobByteString(data));
    if (text === null) throw new NativeError("Blob UTF-8 decoding failed");
    return text;
  };
  const encodeBlobDataUrl = (data) => {
    const size = data.end - data.start;
    const prefix = "data:" + data.type + ";base64,";
    reserveBlobBytes(prefix.length + Math.ceil(size / 3) * 4);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let encoded = "";
    for (let index = data.start; index < data.end; index += 3) {
      const first = data.bytes[index];
      const second = index + 1 < data.end ? data.bytes[index + 1] : 0;
      const third = index + 2 < data.end ? data.bytes[index + 2] : 0;
      encoded += alphabet[first >> 2] + alphabet[((first & 3) << 4) | (second >> 4)] +
        (index + 1 < data.end ? alphabet[((second & 15) << 2) | (third >> 6)] : "=") +
        (index + 2 < data.end ? alphabet[third & 63] : "=");
    }
    return prefix + encoded;
  };
  class Blob {
    constructor(parts = [], options = {}) {
      const init = options == null ? {} : options;
      const endings = init.endings;
      if (endings !== undefined && endings !== "transparent") {
        throw new NativeTypeError("Blob endings must be 'transparent'; native endings are unsupported");
      }
      const type = normalizeBlobType(init.type);
      const copiedParts = [];
      let size = 0;
      const sourceParts = parts == null ? [] : parts;
      for (const part of sourceParts) {
        let copy;
        if (typeof part === "string") {
          const encoded = hostEncodeBlobText(part, MAX_BLOB_BYTES - blobBytesAllocated);
          if (encoded === null) throw blobQuotaError();
          reserveBlobBytes(encoded.length);
          copy = new NativeUint8Array(encoded.length);
          for (let index = 0; index < encoded.length; index += 1) {
            copy[index] = apply(stringCharCodeAt, encoded, [index]);
          }
        } else if (blobData.has(part)) {
          const data = blobData.get(part);
          copy = copyBlobRange(data.bytes.buffer, data.start, data.end - data.start);
        } else if (isView(part)) {
          let buffer;
          let byteOffset;
          let byteLength;
          try {
            buffer = apply(typedArrayBuffer, part, []);
            byteOffset = apply(typedArrayByteOffset, part, []);
            byteLength = apply(typedArrayByteLength, part, []);
          } catch {
            try {
              buffer = apply(dataViewBuffer, part, []);
              byteOffset = apply(dataViewByteOffset, part, []);
              byteLength = apply(dataViewByteLength, part, []);
            } catch {
              throw new NativeTypeError("Blob view part is detached or invalid");
            }
          }
          copy = copyBlobRange(buffer, byteOffset, byteLength);
        } else {
          let byteLength;
          try {
            byteLength = apply(arrayBufferByteLength, part, []);
          } catch {
            throw new NativeTypeError("Blob parts must be strings, ArrayBuffers, views, or Blobs");
          }
          copy = copyBlobRange(part, 0, byteLength);
        }
        copiedParts[copiedParts.length] = copy;
        size += apply(typedArrayByteLength, copy, []);
      }
      const bytes = new NativeUint8Array(size);
      let offset = 0;
      for (let partIndex = 0; partIndex < copiedParts.length; partIndex += 1) {
        const part = copiedParts[partIndex];
        const length = apply(typedArrayByteLength, part, []);
        for (let index = 0; index < length; index += 1) bytes[offset + index] = part[index];
        offset += length;
      }
      blobData.set(this, { bytes, start: 0, end: size, type });
    }
    get size() {
      const data = getBlobData(this);
      return data.end - data.start;
    }
    get type() { return getBlobData(this).type; }
    text() {
      const data = getBlobData(this);
      try {
        return new NativePromise((resolve) => resolve(decodeBlobText(data)));
      } catch (error) {
        return new NativePromise((_resolve, reject) => reject(error));
      }
    }
    arrayBuffer() {
      const data = getBlobData(this);
      try {
        return new NativePromise((resolve) => resolve(copyBlobBytes(data).buffer));
      } catch (error) {
        return new NativePromise((_resolve, reject) => reject(error));
      }
    }
    slice(start = 0, end, contentType = "") {
      const data = getBlobData(this);
      const size = data.end - data.start;
      const first = relativeBlobIndex(start, size);
      const last = end === undefined ? size : relativeBlobIndex(end, size);
      const type = normalizeBlobType(contentType);
      const result = new Blob();
      blobData.set(result, {
        bytes: data.bytes,
        start: data.start + first,
        end: data.start + (last > first ? last : first),
        type,
      });
      return result;
    }
    stream() { throw new NativeTypeError("Blob.stream() is not supported by BrowserMock"); }
  }
  const formDataEntries = new WeakMap();
  const MAX_FORM_DATA_ENTRIES = 256;
  const getFormDataEntries = (value) => {
    const entries = formDataEntries.get(value);
    if (entries === undefined) throw new NativeTypeError("FormData method called on an incompatible receiver");
    return entries;
  };
  const formDataEntryLimitError = () => new NativeTypeError("FormData exceeds the 256-entry limit");
  const reserveFormDataName = (name) => {
    if (name.length > MAX_BLOB_BYTES - blobBytesAllocated || utf8Length(name) > MAX_BLOB_BYTES - blobBytesAllocated) {
      throw blobQuotaError();
    }
    reserveBlobBytes(utf8Length(name));
  };
  const copyFormDataValue = (value) => {
    if (blobData.has(value)) {
      const data = getBlobData(value);
      return new Blob([value], { type: data.type });
    }
    const text = NativeString(value);
    new Blob([text]);
    return text;
  };
  class FormData {
    constructor(...args) {
      if (args.length !== 0) throw new NativeTypeError("FormData HTMLFormElement construction is not supported");
      formDataEntries.set(this, []);
    }
    append(name, value, ...options) {
      if (options.length !== 0) throw new NativeTypeError("FormData filenames are not supported");
      const entries = getFormDataEntries(this);
      if (entries.length >= MAX_FORM_DATA_ENTRIES) throw formDataEntryLimitError();
      const key = NativeString(name);
      reserveFormDataName(key);
      entries[entries.length] = [key, copyFormDataValue(value)];
    }
    set(name, value, ...options) {
      if (options.length !== 0) throw new NativeTypeError("FormData filenames are not supported");
      const key = NativeString(name);
      const entries = getFormDataEntries(this);
      if (entries.length >= MAX_FORM_DATA_ENTRIES && !entries.some(([entryName]) => entryName === key)) throw formDataEntryLimitError();
      reserveFormDataName(key);
      const item = [key, copyFormDataValue(value)];
      let first = -1;
      for (let index = 0; index < entries.length; index += 1) {
        if (entries[index][0] !== key) continue;
        if (first === -1) {
          first = index;
          entries[index] = item;
        } else {
          entries.splice(index, 1);
          index -= 1;
        }
      }
      if (first === -1) entries[entries.length] = item;
    }
    delete(name) {
      const key = NativeString(name);
      const entries = getFormDataEntries(this);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index][0] === key) entries.splice(index, 1);
      }
    }
    get(name) {
      const key = NativeString(name);
      const entries = getFormDataEntries(this);
      for (const [entryName, value] of entries) if (entryName === key) return value;
      return null;
    }
    getAll(name) {
      const key = NativeString(name);
      const values = [];
      for (const [entryName, value] of getFormDataEntries(this)) if (entryName === key) values[values.length] = value;
      return values;
    }
    has(name) {
      const key = NativeString(name);
      for (const [entryName] of getFormDataEntries(this)) if (entryName === key) return true;
      return false;
    }
    *entries() {
      for (const [name, value] of getFormDataEntries(this)) yield [name, value];
    }
    *keys() {
      for (const [name] of getFormDataEntries(this)) yield name;
    }
    *values() {
      for (const [, value] of getFormDataEntries(this)) yield value;
    }
    forEach(callback, thisArg) {
      if (typeof callback !== "function") throw new NativeTypeError("FormData.forEach callback must be a function");
      for (const [name, value] of getFormDataEntries(this)) apply(callback, thisArg, [value, name, this]);
    }
    [Symbol.iterator]() { return this.entries(); }
  }
  const multipartTextLength = (text, escapeName) => {
    let bytes = 0;
    for (let index = 0; index < text.length; index += 1) {
      const code = apply(stringCharCodeAt, text, [index]);
      if (code === 13 || code === 10) {
        if (escapeName) {
          bytes += 6;
          if (code === 13 && index + 1 < text.length && apply(stringCharCodeAt, text, [index + 1]) === 10) index += 1;
        } else {
          bytes += 2;
          if (code === 13 && index + 1 < text.length && apply(stringCharCodeAt, text, [index + 1]) === 10) index += 1;
        }
      } else if (escapeName && code === 34) bytes += 3;
      else if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && apply(stringCharCodeAt, text, [index + 1]) >= 0xdc00 && apply(stringCharCodeAt, text, [index + 1]) <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    }
    return bytes;
  };
  const encodeMultipartText = (text, escapeName) => {
    let result = "";
    for (let index = 0; index < text.length; index += 1) {
      const code = apply(stringCharCodeAt, text, [index]);
      if (code === 13 || code === 10) {
        result += escapeName ? "%0D%0A" : "\r\n";
        if (code === 13 && index + 1 < text.length && apply(stringCharCodeAt, text, [index + 1]) === 10) index += 1;
      } else if (escapeName && code === 34) result += "%22";
      else result += apply(stringFromCharCode, NativeString, [code]);
    }
    return result;
  };
  const randomMultipartBoundary = () => {
    const random = new NativeUint8Array(16);
    getRandomValues(random);
    let suffix = "";
    for (let index = 0; index < random.length; index += 1) {
      const value = apply(numberToString, random[index], [16]);
      suffix += value.length === 1 ? "0" + value : value;
    }
    return "----BrowserMockFormBoundary" + suffix;
  };
  const serializeFormData = (formData) => {
    const boundary = randomMultipartBoundary();
    const entries = getFormDataEntries(formData);
    const dispositionPrefix = "--" + boundary + "\r\nContent-Disposition: form-data; name=\"";
    const dispositionSuffix = "\"\r\n";
    const blobDispositionSuffix = "\"; filename=\"blob\"\r\n";
    let size = utf8Length("--" + boundary + "--\r\n");
    for (const [name, value] of entries) {
      const isBlob = blobData.has(value);
      const suffix = isBlob ? blobDispositionSuffix : dispositionSuffix;
      size += utf8Length(dispositionPrefix) + multipartTextLength(name, true) + utf8Length(suffix + "\r\n");
      if (isBlob) {
        const data = getBlobData(value);
        size += utf8Length("Content-Type: " + (data.type || "application/octet-stream") + "\r\n");
        size += data.end - data.start;
      } else {
        size += multipartTextLength(value, false);
      }
      size += 2;
      if (size > ${limits.maxRequestBodyBytes}) throw new NativeTypeError("FormData request body exceeds the 16 KiB limit");
    }
    const segments = [];
    for (const [name, value] of entries) {
      const isBlob = blobData.has(value);
      let header = dispositionPrefix + encodeMultipartText(name, true) + (isBlob ? blobDispositionSuffix : dispositionSuffix);
      if (isBlob) {
        const data = getBlobData(value);
        header += "Content-Type: " + (data.type || "application/octet-stream") + "\r\n";
        segments[segments.length] = { header, data };
      } else {
        segments[segments.length] = { header, text: encodeMultipartText(value, false) };
      }
    }
    const bytes = new NativeUint8Array(size);
    let offset = 0;
    const appendText = (text) => {
      const encoded = hostEncodeBlobText(text, bytes.length - offset);
      if (encoded === null) throw new NativeTypeError("FormData UTF-8 encoding exceeded the request body limit");
      for (let index = 0; index < encoded.length; index += 1) bytes[offset++] = apply(stringCharCodeAt, encoded, [index]);
    };
    for (const segment of segments) {
      appendText(segment.header + "\r\n");
      if (segment.data !== undefined) {
        for (let index = segment.data.start; index < segment.data.end; index += 1) bytes[offset++] = segment.data.bytes[index];
      } else {
        appendText(segment.text);
      }
      appendText("\r\n");
    }
    appendText("--" + boundary + "--\r\n");
    if (offset !== size) throw new NativeError("FormData serialization length mismatch");
    return { bytes, contentType: "multipart/form-data; boundary=" + boundary };
  };
  const cookieMap = (value) => {
    const result = new Map();
    for (const part of String(value).split(";")) {
      const equals = part.indexOf("=");
      if (equals > 0) result.set(part.slice(0, equals).trim(), part.slice(equals + 1).trim());
    }
    return result;
  };
  let visibleCookies = authoritativeCookies ? String(__cookie) : cookieMap(__cookie);
  let cookieVersion = 0;
  let acknowledgedCookieVersion = 0;
  let cookieBytes = 0;
  let cookieError = "";
  let pendingCookieWrites = [];
  const cookieWaiters = [];
  const pending = new Map();
  const timers = new Map();
  let nextRequestId = 0;
  let nextTimerId = 0;
  let outgoingIpcBytes = 0;
  let outgoingNetworkBytes = 0;
  let outgoingNetworkRequests = 0;
  const postLine = (line) => {
    const bytes = utf8Length(line) + 1;
    if (bytes - 1 > MAX_OUTPUT_LINE_BYTES || outgoingIpcBytes + bytes > MAX_OUTPUT_BYTES) return false;
    if (post(line) === false) return false;
    outgoingIpcBytes += bytes;
    return true;
  };
  const send = (message) => {
    try { postLine(JSON.stringify(message)); } catch {}
  };
  const applyVisibleCookie = (text) => {
    const first = text.split(";", 1)[0] || "";
    const equals = first.indexOf("=");
    if (equals <= 0) return;
    const name = first.slice(0, equals).trim();
    const value = first.slice(equals + 1).trim();
    const maxAge = /(?:^|;)\s*max-age\s*=\s*(-?\d+)/i.exec(text);
    if (maxAge && Number(maxAge[1]) <= 0) visibleCookies.delete(name);
    else visibleCookies.set(name, value);
  };
  const setCookie = (value) => {
    const text = String(value);
    if (/(?:^|;)\s*httponly(?:\s*=|;|$)/i.test(text)) return;
    const first = text.split(";", 1)[0] || "";
    if (first.indexOf("=") <= 0) return;
    const bytes = utf8Length(text);
    if (pendingCookieWrites.length >= ${limits.maxCookieWrites} || cookieBytes + bytes > ${limits.maxCookieBytes}) {
      cookieError = "script cookie output exceeds the configured limit";
      return;
    }
    cookieBytes += bytes;
    cookieVersion += 1;
    pendingCookieWrites.push({ version: cookieVersion, value: text });
    if (!authoritativeCookies) applyVisibleCookie(text);
    send({ type: "cookie.write", version: cookieVersion, value: text });
  };
  const syncCookies = (cookie, version, applied, error) => {
    if (error) {
      cookieError = String(error);
      for (const waiter of cookieWaiters.splice(0)) waiter.reject(new TypeError(cookieError));
      return;
    }
    if (applied && version >= acknowledgedCookieVersion) {
      acknowledgedCookieVersion = version;
      pendingCookieWrites = pendingCookieWrites.filter((entry) => entry.version > version);
      visibleCookies = authoritativeCookies ? String(cookie) : cookieMap(cookie);
      for (let index = cookieWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = cookieWaiters[index];
        if (waiter.version <= version) {
          cookieWaiters.splice(index, 1);
          waiter.resolve();
        }
      }
    }
  };
  const flushCookies = () => {
    if (cookieError) return Promise.reject(new TypeError(cookieError));
    if (!authoritativeCookies || cookieVersion <= acknowledgedCookieVersion) return Promise.resolve();
    return new Promise((resolve, reject) => cookieWaiters.push({ version: cookieVersion, resolve, reject }));
  };
  const request = (kind, url, method, headers, body) => flushCookies().then(() => new Promise((resolve, reject) => {
    try {
      if (outgoingNetworkRequests >= MAX_NETWORK_REQUESTS) throw new NativeTypeError("script network request budget exceeded");
      if (headers.values.length > MAX_HEADERS) throw new NativeTypeError("script request exceeds the header-count limit");
      let headerBytes = 0;
      for (const [name, value] of headers.values) {
        headerBytes += utf8Length(name) + utf8Length(value);
        if (headerBytes > MAX_HEADER_BYTES) throw new NativeTypeError("script request headers exceed the 64 KiB limit");
      }
      if (body !== null && typeof body !== "string" && !(body instanceof NativeUint8Array)) throw new NativeTypeError("script request body must be a string or byte array");
      let bodyLength = 0;
      if (typeof body === "string") bodyLength = utf8Length(body);
      else if (body !== null) bodyLength = body.byteLength;
      if (bodyLength > MAX_REQUEST_BODY_BYTES) throw new NativeTypeError("script request body exceeds the 16 KiB limit");
      const id = nextRequestId + 1;
      const message = { type: "network", id, kind, url: String(url), method, headers: Array.from(headers), body: null, cookieVersion };
      const metadataBytes = utf8Length(JSON.stringify(message));
      let encodedBodyBytes = 4;
      if (typeof body === "string") encodedBodyBytes = utf8Length(JSON.stringify(body));
      else if (body instanceof NativeUint8Array) {
        encodedBodyBytes = 2;
        for (let index = 0; index < body.byteLength; index += 1) {
          const value = body[index];
          encodedBodyBytes += value < 10 ? 1 : value < 100 ? 2 : 3;
          if (index > 0) encodedBodyBytes += 1;
        }
      }
      const lineBytes = metadataBytes - 4 + encodedBodyBytes;
      if (lineBytes > MAX_OUTPUT_LINE_BYTES) throw new NativeTypeError("script request exceeds the 128 KiB IPC line limit");
      if (outgoingNetworkBytes + lineBytes > MAX_TOTAL_NETWORK_BYTES) throw new NativeTypeError("script network byte budget exceeded");
      if (outgoingIpcBytes + lineBytes + 1 > MAX_OUTPUT_BYTES) throw new NativeTypeError("script runner output exceeds the 1 MiB limit");
      message.body = body instanceof NativeUint8Array ? Array.from(body) : body;
      const line = JSON.stringify(message);
      if (utf8Length(line) !== lineBytes) throw new NativeError("script request IPC size mismatch");
      pending.set(id, { resolve, reject, kind });
      if (!postLine(line)) {
        pending.delete(id);
        throw new NativeTypeError("script request exceeds the runner IPC budget");
      }
      nextRequestId = id;
      outgoingNetworkBytes += lineBytes;
      outgoingNetworkRequests += 1;
    } catch (cause) {
      reject(cause);
    }
  }));
  const safeMessage = (cause) => {
    try {
      if (typeof cause === "string") return cause;
      const message = cause && cause.message;
      return typeof message === "string" ? message : "script execution failed";
    } catch { return "script execution failed"; }
  };
  const fireTimer = (id) => {
    const timer = timers.get(id);
    if (!timer) return;
    if (timer.interval === undefined) timers.delete(id);
    try { timer.callback(...timer.args); }
    catch (cause) { send({ type: "script.error", reason: safeMessage(cause) }); }
    if (timer.interval !== undefined && timers.get(id) === timer) {
      send({ type: "timer.set", id, ms: timer.interval });
    }
  };
  const receive = (raw) => {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.type === "cookie.sync") {
      syncCookies(message.cookie, message.version, message.applied, message.error);
      return;
    }
    if (message.type === "timer.fire") {
      fireTimer(message.id);
      return;
    }
    if (message.type === "fatal") {
      send({ type: "script.error", reason: String(message.reason) });
      return;
    }
    if (message.type !== "reply") return;
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    if (!message.ok) {
      task.reject(new TypeError(String(message.error)));
      return;
    }
    const response = message.response;
    syncCookies(response.cookie, response.appliedCookieVersion, true, "");
    if (response.error) task.reject(new TypeError(String(response.error)));
    else task.resolve(response);
  };
  class Headers {
    constructor(input) {
      this.values = [];
      if (input instanceof Headers) {
        for (const [name, value] of input.values) this.append(name, value);
      } else if (Array.isArray(input)) {
        for (const pair of input) this.append(pair[0], pair[1]);
      } else if (input && typeof input === "object") {
        for (const [name, value] of Object.entries(input)) this.append(name, value);
      }
    }
    append(name, value) { this.values.push([String(name).toLowerCase(), String(value)]); }
    set(name, value) {
      const key = String(name).toLowerCase();
      this.values = this.values.filter(([entry]) => entry !== key);
      this.append(key, value);
    }
    get(name) {
      const key = String(name).toLowerCase();
      const values = this.values.filter(([entry]) => entry === key).map(([, value]) => value);
      return values.length === 0 ? null : values.join(", ");
    }
    has(name) { return this.values.some(([entry]) => entry === String(name).toLowerCase()); }
    forEach(callback, thisArg) {
      for (const [name, value] of this.values) callback.call(thisArg, value, name, this);
    }
    entries() { return this.values[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
  }
  class Response {
    constructor(value) {
      this.status = value.status;
      this.statusText = "";
      this.url = value.url;
      this.ok = this.status >= 200 && this.status < 300;
      this.headers = new Headers(value.headers);
      this.bodyUsed = false;
      this.bodyText = value.body;
    }
    text() {
      if (this.bodyUsed) return Promise.reject(new TypeError("response body already used"));
      this.bodyUsed = true;
      return Promise.resolve(this.bodyText);
    }
    json() { return this.text().then((text) => JSON.parse(text)); }
  }
  const fetch = (input, init = {}) => {
    try {
      if (init.credentials !== undefined && init.credentials !== "same-origin") throw new TypeError("fetch credentials mode is not supported");
      if (init.redirect !== undefined && init.redirect !== "follow") throw new TypeError("fetch redirect mode is not supported");
      if (init.mode !== undefined) throw new TypeError("fetch mode is not supported");
      const url = typeof input === "string" ? input : input && input.url;
      if (typeof url !== "string") throw new TypeError("fetch expects a URL string");
      const method = String(init.method || "GET").toUpperCase();
      const headers = new Headers(init.headers);
      let body = null;
      if (init.body instanceof FormData) {
        if (method === "GET" || method === "HEAD") throw new TypeError("GET and HEAD cannot have a body");
        const multipart = serializeFormData(init.body);
        body = multipart.bytes;
        if (!headers.has("content-type")) headers.set("content-type", multipart.contentType);
      } else if (init.body != null) {
        if (typeof init.body !== "string") throw new TypeError("fetch supports string and FormData request bodies only");
        body = init.body;
      }
      if ((method === "GET" || method === "HEAD") && body !== null) throw new TypeError("GET and HEAD cannot have a body");
      return request("fetch", url, method, headers, body).then((value) => new Response(value));
    } catch (cause) { return Promise.reject(cause); }
  };
  function XMLHttpRequest() {
    this.readyState = 0;
    this.status = 0;
    this.statusText = "";
    this.responseText = "";
    this.response = null;
    this.responseURL = "";
    this.responseType = "";
    this.onreadystatechange = null;
    this.onload = null;
    this.onerror = null;
    this.onloadend = null;
    Object.defineProperty(this, "withCredentials", {
      enumerable: true,
      get: () => false,
      set: (value) => {
        if (value) throw new TypeError("XMLHttpRequest.withCredentials is not supported");
      },
    });
    this._headers = new Headers();
    this._listeners = new Map();
  }
  XMLHttpRequest.prototype.addEventListener = function(type, callback) {
    const listeners = this._listeners.get(type) || [];
    listeners.push(callback);
    this._listeners.set(type, listeners);
  };
  XMLHttpRequest.prototype.removeEventListener = function(type, callback) {
    this._listeners.set(type, (this._listeners.get(type) || []).filter((entry) => entry !== callback));
  };
  XMLHttpRequest.prototype._emit = function(type) {
    const event = { type, target: this, currentTarget: this };
    const callbacks = [...(this._listeners.get(type) || [])];
    if (typeof this["on" + type] === "function") callbacks.push(this["on" + type]);
    for (const callback of callbacks) {
      try { callback.call(this, event); }
      catch (cause) { send({ type: "script.error", reason: safeMessage(cause) }); }
    }
  };
  XMLHttpRequest.prototype.open = function(method, url, async = true) {
    if (async === false) throw new TypeError("synchronous XMLHttpRequest is not supported");
    this._method = String(method).toUpperCase();
    this._url = String(url);
    this.readyState = 1;
    this._emit("readystatechange");
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (this.readyState !== 1) throw new TypeError("open() must be called before setRequestHeader()");
    this._headers.append(name, value);
  };
  XMLHttpRequest.prototype.send = function(body = null) {
    if (this.readyState !== 1) throw new TypeError("open() must be called before send()");
    if (body instanceof FormData) {
      const multipart = serializeFormData(body);
      body = multipart.bytes;
      if (!this._headers.has("content-type")) this._headers.set("content-type", multipart.contentType);
    } else if (body !== null && typeof body !== "string") throw new TypeError("XMLHttpRequest supports string and FormData request bodies only");
    request("fetch", this._url, this._method, this._headers, body).then((value) => {
      this.status = value.status;
      this.statusText = "";
      this.responseURL = value.url;
      this.responseText = value.body;
      this.response = this.responseType === "json" ? (() => { try { return JSON.parse(value.body); } catch { return null; } })() : value.body;
      this.readyState = 2; this._emit("readystatechange");
      this.readyState = 3; this._emit("readystatechange");
      this.readyState = 4; this._emit("readystatechange");
      this._emit("load"); this._emit("loadend");
    }, () => {
      this.status = 0;
      this.readyState = 4;
      this._emit("readystatechange");
      this._emit("error"); this._emit("loadend");
    });
  };
  const setTimeout = (callback, delay = 0, ...args) => {
    if (typeof callback !== "function") throw new TypeError("timer callback must be a function");
    if (timers.size >= ${limits.maxTimers}) throw new RangeError("script timer budget exceeded");
    const id = ++nextTimerId;
    const ms = Number.isFinite(Number(delay)) ? Math.max(0, Math.min(Number(delay), ${limits.maxTimerDelayMs})) : 0;
    timers.set(id, { callback, args });
    send({ type: "timer.set", id, ms });
    return id;
  };
  const setInterval = (callback, delay = 0, ...args) => {
    if (typeof callback !== "function") throw new TypeError("timer callback must be a function");
    if (timers.size >= ${limits.maxTimers}) throw new RangeError("script timer budget exceeded");
    const id = ++nextTimerId;
    const ms = Number.isFinite(Number(delay)) ? Math.max(0, Math.min(Number(delay), ${limits.maxTimerDelayMs})) : 0;
    timers.set(id, { callback, args, interval: ms });
    send({ type: "timer.set", id, ms });
    return id;
  };
  const clearTimeout = (id) => {
    const number = Number(id);
    if (timers.delete(number)) send({ type: "timer.clear", id: number });
  };
  const clearInterval = clearTimeout;
  class Event {
    constructor(type, options = {}) {
      const init = options == null ? {} : options;
      this._type = String(type);
      this._bubbles = Boolean(init.bubbles);
      this._cancelable = Boolean(init.cancelable);
      this._defaultPrevented = false;
      this._target = null;
      this._currentTarget = null;
      this._dispatching = false;
      this._immediateStopped = false;
      this._inPassiveListener = false;
    }
    get type() { return this._type; }
    get bubbles() { return this._bubbles; }
    get cancelable() { return this._cancelable; }
    get defaultPrevented() { return this._defaultPrevented; }
    get isTrusted() { return false; }
    get target() { return this._target; }
    get currentTarget() { return this._currentTarget; }
    preventDefault() {
      if (this.cancelable && !this._inPassiveListener) this._defaultPrevented = true;
    }
    stopImmediatePropagation() { this._immediateStopped = true; }
  }
  class ProgressEvent extends Event {
    constructor(type, options = {}) {
      const init = options == null ? {} : options;
      super(type, init);
      Object.defineProperties(this, {
        lengthComputable: { value: Boolean(init.lengthComputable), enumerable: true },
        loaded: { value: init.loaded === undefined ? 0 : NativeNumber(init.loaded), enumerable: true },
        total: { value: init.total === undefined ? 0 : NativeNumber(init.total), enumerable: true },
      });
    }
  }
  const makeEventTarget = (target) => {
    const listeners = new Map();
    const captureOf = (options) => typeof options === "boolean" ? options : Boolean(options && options.capture);
    target.addEventListener = (type, callback, options = false) => {
      if (callback == null) return;
      if (typeof callback !== "function" && (typeof callback !== "object" || typeof callback.handleEvent !== "function")) {
        throw new TypeError("event listener must be a function or an object with handleEvent");
      }
      const name = String(type);
      const capture = captureOf(options);
      const init = typeof options === "object" && options !== null ? options : {};
      if (init.signal != null) throw new TypeError("event listener AbortSignal is not supported");
      const entries = listeners.get(name) || [];
      if (entries.some((entry) => entry.callback === callback && entry.capture === capture)) return;
      entries.push({ callback, capture, once: Boolean(init.once), passive: Boolean(init.passive) });
      listeners.set(name, entries);
    };
    target.removeEventListener = (type, callback, options = false) => {
      if (callback == null) return;
      const name = String(type);
      const entries = listeners.get(name) || [];
      const index = entries.findIndex((entry) => entry.callback === callback && entry.capture === captureOf(options));
      if (index !== -1) entries.splice(index, 1);
      if (entries.length === 0) listeners.delete(name);
    };
    target.dispatchEvent = (event) => {
      if (!(event instanceof Event)) throw new TypeError("dispatchEvent expects an Event");
      if (event._dispatching) throw new TypeError("event is already being dispatched");
      const name = event.type;
      const entries = [...(listeners.get(name) || [])].sort(
        (left, right) => Number(right.capture) - Number(left.capture),
      );
      event._dispatching = true;
      event._target = target;
      event._currentTarget = target;
      event._immediateStopped = false;
      try {
        for (const entry of entries) {
          if (!(listeners.get(name) || []).includes(entry)) continue;
          if (entry.once) target.removeEventListener(name, entry.callback, entry.capture);
          try {
            event._inPassiveListener = entry.passive;
            if (typeof entry.callback === "function") entry.callback.call(target, event);
            else entry.callback.handleEvent.call(entry.callback, event);
          } catch (cause) {
            send({ type: "script.error", reason: safeMessage(cause) });
          } finally {
            event._inPassiveListener = false;
          }
          if (event._immediateStopped) break;
        }
      } finally {
        event._currentTarget = null;
        event._dispatching = false;
        event._inPassiveListener = false;
        event._immediateStopped = false;
      }
      return !event.defaultPrevented;
    };
    return target;
  };
  const fileReaderState = new WeakMap();
  const getFileReaderState = (reader) => {
    const state = fileReaderState.get(reader);
    if (state === undefined) throw new NativeTypeError("FileReader method called on an incompatible receiver");
    return state;
  };
  const fileReaderError = (name, message) => {
    const error = new NativeError(message);
    error.name = name;
    return error;
  };
  const dispatchFileReaderEvent = (reader, type, loaded, total) => {
    reader.dispatchEvent(new ProgressEvent(type, {
      lengthComputable: true,
      loaded,
      total,
    }));
  };
  const finishFileRead = (reader, state, task, result, error) => {
    if (state.task !== task) return;
    state.task = null;
    state.readyState = FileReader.DONE;
    state.result = error === null ? result : null;
    state.error = error;
    const size = task.data.end - task.data.start;
    dispatchFileReaderEvent(reader, error === null ? "load" : "error", task.loaded, size);
    if (state.readyState !== FileReader.LOADING) {
      dispatchFileReaderEvent(reader, "loadend", task.loaded, size);
    }
  };
  const completeFileRead = (reader, state, task) => {
    task.timer = null;
    if (state.task !== task) return;
    const size = task.data.end - task.data.start;
    if (size > 0) {
      task.loaded = size;
      dispatchFileReaderEvent(reader, "progress", size, size);
    }
    if (state.task !== task) return;
    try {
      const result = task.kind === "arrayBuffer"
        ? copyBlobBytes(task.data).buffer
        : task.kind === "text"
          ? decodeBlobText(task.data)
          : encodeBlobDataUrl(task.data);
      finishFileRead(reader, state, task, result, null);
    } catch (error) {
      finishFileRead(reader, state, task, null, error);
    }
  };
  const startFileRead = (reader, blob, kind, encoding) => {
    const state = getFileReaderState(reader);
    if (state.readyState === FileReader.LOADING || state.task !== null) {
      throw fileReaderError("InvalidStateError", "A FileReader read is already in progress");
    }
    const data = getBlobData(blob);
    if (kind === "text" && encoding != null) {
      const label = NativeString(encoding).trim().toLowerCase();
      if (label !== "" && label !== "utf-8" && label !== "utf8") {
        throw new NativeTypeError("FileReader supports UTF-8 text only");
      }
    }
    const task = { data, kind, timer: null, loaded: 0 };
    state.task = task;
    state.result = null;
    state.error = null;
    state.readyState = FileReader.LOADING;
    try {
      task.timer = setTimeout(() => {
        task.timer = null;
        if (state.task !== task) return;
        dispatchFileReaderEvent(reader, "loadstart", 0, task.data.end - task.data.start);
        if (state.task !== task) return;
        try {
          task.timer = setTimeout(() => completeFileRead(reader, state, task), 0);
        } catch (error) {
          finishFileRead(reader, state, task, null, error);
        }
      }, 0);
    } catch (error) {
      state.task = null;
      state.result = null;
      state.error = null;
      state.readyState = FileReader.EMPTY;
      throw error;
    }
  };
  const abortFileRead = (reader) => {
    const state = getFileReaderState(reader);
    if (state.readyState === FileReader.EMPTY || state.readyState === FileReader.DONE) {
      state.result = null;
      return;
    }
    const task = state.task;
    state.readyState = FileReader.DONE;
    state.result = null;
    if (task !== null) {
      if (task.timer !== null) clearTimeout(task.timer);
      task.timer = null;
      state.task = null;
    }
    const size = task === null ? 0 : task.data.end - task.data.start;
    const loaded = task === null ? 0 : task.loaded;
    dispatchFileReaderEvent(reader, "abort", loaded, size);
    if (state.readyState !== FileReader.LOADING) {
      dispatchFileReaderEvent(reader, "loadend", loaded, size);
    }
  };
  class FileReader {
    static EMPTY = 0;
    static LOADING = 1;
    static DONE = 2;
    get EMPTY() { return FileReader.EMPTY; }
    get LOADING() { return FileReader.LOADING; }
    get DONE() { return FileReader.DONE; }
    constructor() {
      fileReaderState.set(this, {
        readyState: FileReader.EMPTY,
        result: null,
        error: null,
        task: null,
      });
      makeEventTarget(this);
      for (const type of ["loadstart", "progress", "load", "error", "abort", "loadend"]) {
        let callback = null;
        let listener = null;
        Object.defineProperty(this, "on" + type, {
          enumerable: true,
          configurable: true,
          get: () => callback,
          set: (value) => {
            if (listener !== null) this.removeEventListener(type, listener);
            callback = typeof value === "function" ? value : null;
            listener = callback === null ? null : (event) => callback.call(this, event);
            if (listener !== null) this.addEventListener(type, listener);
          },
        });
      }
    }
    get readyState() { return getFileReaderState(this).readyState; }
    get result() { return getFileReaderState(this).result; }
    get error() { return getFileReaderState(this).error; }
    readAsArrayBuffer(blob) { startFileRead(this, blob, "arrayBuffer"); }
    readAsText(blob, encoding) { startFileRead(this, blob, "text", encoding); }
    readAsDataURL(blob) { startFileRead(this, blob, "dataURL"); }
    abort() { abortFileRead(this); }
  }
  const document = makeEventTarget({});
  Object.defineProperty(document, "cookie", {
    enumerable: true,
    get: () => authoritativeCookies ? visibleCookies : Array.from(visibleCookies, ([name, value]) => name + "=" + value).join("; "),
    set: setCookie,
  });
  document.location = Object.freeze({ href: initialUrl });
  document.referrer = "";
  document.loadScript = (url) => request("script", String(url), "GET", new Headers([["accept", "text/javascript, application/javascript, */*"]]), null).then((value) => {
    if (value.status < 200 || value.status >= 300) throw new TypeError("script load failed with HTTP " + value.status);
    return undefined;
  });
  const navigator = Object.freeze({ userAgent, language: "en-US", languages: Object.freeze(["en-US"]), cookieEnabled: true, webdriver: false });
  const console = Object.freeze({ log() {}, warn() {}, error() {}, info() {} });
  const window = makeEventTarget(globalThis);
  Object.assign(window, { document, location: document.location, navigator, console, performance, crypto, fetch, XMLHttpRequest, setTimeout, clearTimeout, setInterval, clearInterval, Headers, Response, Event, ProgressEvent, Blob, FileReader, FormData });
  window.window = window; window.self = window; window.globalThis = window;
  Object.defineProperty(globalThis, "__receive", { value: receive, configurable: true });
  Object.defineProperty(globalThis, "__cookieSnapshot", {
    configurable: true,
    value: () => JSON.stringify({ setCookies: pendingCookieWrites.map((entry) => entry.value), error: cookieError }),
  });
  Object.defineProperty(globalThis, "__cookieFlush", { value: flushCookies, configurable: true });
  Object.defineProperty(globalThis, "__safeMessage", { value: safeMessage, configurable: true });
})();
`;

  return String.raw`
const vm = require("node:vm");
const readline = require("node:readline");
const hostPerformance = require("node:perf_hooks").performance;
const hostMonotonicNow = () => hostPerformance.now();
const hostTimeOrigin = hostPerformance.timeOrigin;
const hostEncodeBlobText = (text, maxBytes) => {
  try {
    if (typeof text !== "string" || !Number.isInteger(maxBytes) || maxBytes < 0) return null;
    if (Buffer.byteLength(text, "utf8") > maxBytes) return null;
    return Buffer.from(text, "utf8").toString("latin1");
  } catch { return null; }
};
const hostDecodeBlobText = (bytes) => {
  try { return typeof bytes === "string" ? Buffer.from(bytes, "latin1").toString("utf8") : null; }
  catch { return null; }
};
const { randomFillSync: hostRandomFillSync } = require("node:crypto");
const MAX_RANDOM_BYTES = 65536;
const hostRandomBytes = (byteLength) => {
  try {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_RANDOM_BYTES) return null;
    return hostRandomFillSync(Buffer.allocUnsafe(byteLength)).toString("latin1");
  } catch { return null; }
};
const MAX_INPUT_LINE_BYTES = ${limits.maxInputLineBytes};
const MAX_CONTROL_INPUT_LINE_BYTES = ${limits.maxControlInputLineBytes};
const MAX_OUTPUT_LINE_BYTES = ${limits.maxOutputLineBytes};
const MAX_OUTPUT_BYTES = ${limits.maxOutputBytes};
let outputBytes = 0;
const pendingKinds = new Map();
let context;
let deliver;
let finished = false;
const safeMessage = (cause) => {
  try {
    if (typeof cause === "string") return cause;
    const message = cause && cause.message;
    return typeof message === "string" ? message : "script execution failed";
  } catch { return "script execution failed"; }
};
const writeFinal = (output) => {
  if (finished) return;
  finished = true;
  process.stdout.end(JSON.stringify({ type: "result", output }) + "\n", () => process.exit(0));
};
const post = (line) => {
  try {
    const bytes = Buffer.byteLength(line) + 1;
    if (typeof line !== "string" || bytes - 1 > MAX_OUTPUT_LINE_BYTES || outputBytes + bytes > MAX_OUTPUT_BYTES) return false;
    const message = JSON.parse(line);
    if (message.type === "network") pendingKinds.set(message.id, message.kind);
    outputBytes += bytes;
    process.stdout.write(line + "\n");
    return true;
  } catch { return false; }
};
const bootstrap = ${JSON.stringify(bootstrap)};
const handleParentLine = (line) => {
  try {
    if (Buffer.byteLength(line) > MAX_INPUT_LINE_BYTES) throw new Error("host IPC line exceeds the limit");
    let message = JSON.parse(line);
    if (message.type === "fatal") {
      writeFinal({ ok: false, reason: String(message.reason) });
      return;
    }
    if (message.type === "reply") {
      const kind = pendingKinds.get(message.id);
      pendingKinds.delete(message.id);
      if (message.ok && kind === "script") {
        if (!message.response.error && message.response.status >= 200 && message.response.status < 300) {
          try { vm.runInContext(message.response.body, context); }
          catch (cause) {
            message = { type: "reply", id: message.id, ok: false, error: "loaded script failed: " + safeMessage(cause) };
          }
        }
        if (message.ok) message.response.body = "";
      }
    }
    deliver(JSON.stringify(message));
  } catch (cause) { writeFinal({ ok: false, reason: safeMessage(cause) }); }
};
const start = (input) => {
  const sandbox = Object.assign(Object.create(null), {
    __post: post,
    __pageUrl: String(input.url),
    __cookie: String(input.cookie),
    __userAgent: String(input.userAgent),
    __authoritativeCookies: input.authoritativeCookies,
    __performanceNow: hostMonotonicNow,
    __performanceTimeOrigin: hostTimeOrigin,
    __randomBytes: hostRandomBytes,
    __encodeBlobText: hostEncodeBlobText,
    __decodeBlobText: hostDecodeBlobText,
  });
  context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(bootstrap, context);
  deliver = vm.runInContext("__receive", context);
  delete sandbox.__post;
  delete sandbox.__pageUrl;
  delete sandbox.__cookie;
  delete sandbox.__userAgent;
  delete sandbox.__receive;
  delete sandbox.__performanceNow;
  delete sandbox.__performanceTimeOrigin;
  delete sandbox.__randomBytes;
  delete sandbox.__encodeBlobText;
  delete sandbox.__decodeBlobText;
  const wrapper = "(async function () {\n" +
    "  const snapshot = __cookieSnapshot; const flush = __cookieFlush; const describe = __safeMessage;\n" +
    "  delete globalThis.__cookieSnapshot; delete globalThis.__cookieFlush; delete globalThis.__safeMessage;\n" +
    "  try { const value = await (async function () {\n" + input.source + "\n})(); await flush();\n" +
    "    const state = JSON.parse(snapshot()); if (state.error) return JSON.stringify({ ok: false, reason: state.error });\n" +
    "    return JSON.stringify({ ok: true, value: String(value == null ? \"\" : value), setCookies: state.setCookies });\n" +
    "  } catch (cause) { try { await flush(); } catch (flushCause) { cause = flushCause; } const state = JSON.parse(snapshot()); return JSON.stringify({ ok: false, reason: describe(cause), setCookies: state.setCookies }); }\n" +
    "})()";
  try {
    Promise.resolve(vm.runInContext(wrapper, context)).then((encoded) => {
      try { writeFinal(JSON.parse(encoded)); }
      catch (cause) { writeFinal({ ok: false, reason: safeMessage(cause) }); }
    }, (cause) => writeFinal({ ok: false, reason: safeMessage(cause) }));
  } catch (cause) { writeFinal({ ok: false, reason: safeMessage(cause) }); }
};
const major = Number.parseInt(process.versions.node, 10);
if (!Number.isInteger(major) || major < 25 || process.permission?.has("net") !== false) {
  writeFinal({ ok: false, reason: "BrowserMock requires Node 25+ network permission denial support" });
} else {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let started = false;
  lines.on("line", (line) => {
    if (finished) return;
    const lineLimit = started
      ? MAX_INPUT_LINE_BYTES
      : MAX_CONTROL_INPUT_LINE_BYTES;
    if (Buffer.byteLength(line) > lineLimit) {
      writeFinal({ ok: false, reason: "host IPC line exceeds the limit" });
      return;
    }
    if (!started) {
      started = true;
      try { start(JSON.parse(line)); }
      catch (cause) { writeFinal({ ok: false, reason: safeMessage(cause) }); }
      return;
    }
    handleParentLine(line);
  });
}
`;
};
