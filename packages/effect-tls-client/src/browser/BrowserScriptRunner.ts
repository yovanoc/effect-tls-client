interface RunnerLimits {
  readonly maxTimeoutMs: number;
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
  const childRealm = __childRealm;
  const consumeBudget = __consumeBudget;
  delete globalThis.__childRealm; delete globalThis.__consumeBudget;
  // Host helpers exchange only primitives; no host objects enter the VM.
  const hostUrlOperation = __urlOperation;
  delete globalThis.__urlOperation;
  const hostCryptoOperation = __cryptoOperation;
  delete globalThis.__cryptoOperation;
  const jsonParse = JSON.parse;
  const jsonStringify = JSON.stringify;
  const pageLocationData = jsonParse(__pageLocation);
  delete globalThis.__pageLocation;
  const hostRandomBytes = __randomBytes;
  const hostEncodeBlobText = __encodeBlobText;
  const hostDecodeBlobText = __decodeBlobText;
  const NativeUint8Array = Uint8Array;
  const NativeArrayBuffer = ArrayBuffer;
  const NativePromise = Promise;
  const NativeError = Error;
  const NativeTypeError = TypeError;
  const NativeRangeError = RangeError;
  const NativeString = String;
  const NativeNumber = Number;
  const mathTrunc = Math.trunc;
  const apply = Reflect.apply;
  const objectFreeze = Object.freeze;
  const objectDefineProperties = Object.defineProperties;
  const arrayIsArray = Array.isArray;
  const objectCreate = Object.create;
  const numberIsInteger = Number.isInteger;
  const promiseThen = NativePromise.prototype.then;
  const weakMapGet = WeakMap.prototype.get;
  const weakMapSet = WeakMap.prototype.set;
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
  const stringSlice = String.prototype.slice;
  const numberToString = Number.prototype.toString;
  const MAX_URL_INPUT_LENGTH = 8192;
  const MAX_URL_RESULT_LENGTH = 65536;
  const urlOperation = (operation, input, first = "", second = "") => {
    if (input.length > MAX_URL_INPUT_LENGTH || first.length > MAX_URL_INPUT_LENGTH || second.length > MAX_URL_INPUT_LENGTH) return null;
    const encoded = hostUrlOperation(operation, input, first, second);
    if (typeof encoded !== "string" || encoded.length > MAX_URL_RESULT_LENGTH) return null;
    try { return jsonParse(encoded); } catch { return null; }
  };
  const requireUrlString = (value) => {
    const text = NativeString(value);
    if (text.length > MAX_URL_INPUT_LENGTH) throw new NativeTypeError("URL input exceeds 8192 characters");
    return text;
  };
  const parameterData = new WeakMap();
  const getParameterInput = (value) => {
    const input = parameterData.get(value);
    if (input === undefined) throw new NativeTypeError("URLSearchParams method called on an incompatible receiver");
    return input;
  };
  const parameterValue = (value) => {
    if (!Array.isArray(value) || value.length !== 1) throw new NativeTypeError("URLSearchParams result exceeds the 64 KiB limit");
    return value[0];
  };
  class URLSearchParams {
    constructor(input = "") {
      if (typeof input !== "string") throw new NativeTypeError("BrowserMock URLSearchParams accepts string input only");
      if (input.length > MAX_URL_INPUT_LENGTH) throw new NativeTypeError("URL input exceeds 8192 characters");
      parameterData.set(this, input);
      Object.freeze(this);
    }
    get(name) { return parameterValue(urlOperation("params:get", getParameterInput(this), requireUrlString(name))); }
    append() { throw new NativeTypeError("BrowserMock URLSearchParams is read-only"); }
    delete() { throw new NativeTypeError("BrowserMock URLSearchParams is read-only"); }
    set() { throw new NativeTypeError("BrowserMock URLSearchParams is read-only"); }
    sort() { throw new NativeTypeError("BrowserMock URLSearchParams is read-only"); }
  }
  const urlData = new WeakMap();
  const getUrlData = (value) => {
    const data = urlData.get(value);
    if (data === undefined) throw new NativeTypeError("URL method called on an incompatible receiver");
    return data;
  };
  const readOnlyUrl = () => { throw new NativeTypeError("BrowserMock URL is read-only"); };
  class URL {
    constructor(input, base) {
      const value = requireUrlString(input);
      const parsed = base === undefined
        ? urlOperation("parse", value)
        : urlOperation("parse-base", value, requireUrlString(base));
      if (!Array.isArray(parsed) || parsed.length !== 9 || parsed.some((part) => typeof part !== "string")) {
        throw new NativeTypeError("Invalid URL");
      }
      urlData.set(this, {
        href: parsed[0], origin: parsed[1], protocol: parsed[2], host: parsed[3],
        hostname: parsed[4], port: parsed[5], pathname: parsed[6], search: parsed[7], hash: parsed[8],
        searchParams: null,
      });
      Object.freeze(this);
    }
    get searchParams() {
      const data = getUrlData(this);
      if (data.searchParams === null) data.searchParams = new URLSearchParams(data.search);
      return data.searchParams;
    }
    set searchParams(_value) { readOnlyUrl(); }
    toString() { return getUrlData(this).href; }
  }
  for (const key of ["href", "origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash"]) {
    Object.defineProperty(URL.prototype, key, {
      enumerable: true,
      get() { return getUrlData(this)[key]; },
      set: readOnlyUrl,
    });
  }
  const MAX_CRYPTO_OPERATIONS = 64;
  const MAX_CRYPTO_BYTES = 65536;
  let cryptoOperations = 0;
  const consumeCryptoOperation = () => {
    if (cryptoOperations >= MAX_CRYPTO_OPERATIONS) throw new NativeRangeError("crypto operation budget exceeded");
    if (!consumeBudget("crypto", 1)) throw new NativeRangeError("crypto operation budget exceeded");
    cryptoOperations += 1;
  };
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
  // Keep the host clock closure private; only the local wrapper is script-visible.
  const monotonicNow = __performanceNow;
  const performance = Object.freeze({
    timeOrigin: Number(__performanceTimeOrigin),
    now: () => monotonicNow(),
  });
  const initialUrl = String(__pageUrl);
  const initialReferrer = String(__referrer);
  const userAgent = String(__userAgent);
  const languages = Object.freeze(jsonParse(__languages));
  delete globalThis.__languages;
  const authoritativeCookies = Boolean(__authoritativeCookies);
  const MAX_REQUEST_BODY_BYTES = ${limits.maxRequestBodyBytes};
  const MAX_NETWORK_REQUESTS = ${limits.maxNetworkRequests};
  const MAX_TOTAL_NETWORK_BYTES = ${limits.maxTotalNetworkBytes};
  const MAX_OUTPUT_LINE_BYTES = ${limits.maxOutputLineBytes};
  const MAX_OUTPUT_BYTES = ${limits.maxOutputBytes};
  const MAX_HEADERS = ${limits.maxHeaders};
  const MAX_HEADER_BYTES = ${limits.maxHeaderBytes};
  const utf8Length = (value) => {
    const text = NativeString(value);
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
  const writeUtf8 = (text, destination, capacity) => {
    let read = 0;
    let written = 0;
    while (read < text.length) {
      const first = apply(stringCharCodeAt, text, [read]);
      let codePoint = first;
      let units = 1;
      if (first >= 0xd800 && first <= 0xdbff) {
        const second = read + 1 < text.length ? apply(stringCharCodeAt, text, [read + 1]) : 0;
        if (second >= 0xdc00 && second <= 0xdfff) {
          codePoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
          units = 2;
        } else codePoint = 0xfffd;
      } else if (first >= 0xdc00 && first <= 0xdfff) codePoint = 0xfffd;
      const count = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
      if (written + count > capacity) break;
      if (count === 1) destination[written++] = codePoint;
      else if (count === 2) {
        destination[written++] = 0xc0 | (codePoint >> 6);
        destination[written++] = 0x80 | (codePoint & 0x3f);
      } else if (count === 3) {
        destination[written++] = 0xe0 | (codePoint >> 12);
        destination[written++] = 0x80 | ((codePoint >> 6) & 0x3f);
        destination[written++] = 0x80 | (codePoint & 0x3f);
      } else {
        destination[written++] = 0xf0 | (codePoint >> 18);
        destination[written++] = 0x80 | ((codePoint >> 12) & 0x3f);
        destination[written++] = 0x80 | ((codePoint >> 6) & 0x3f);
        destination[written++] = 0x80 | (codePoint & 0x3f);
      }
      read += units;
    }
    return { read, written };
  };
  const encodeInto = (input, destination) => {
    let byteLength;
    try {
      if (apply(typedArrayTag, destination, []) !== "Uint8Array") throw new NativeTypeError("TextEncoder.encodeInto expects a Uint8Array");
      byteLength = apply(typedArrayByteLength, destination, []);
    } catch {
      throw new NativeTypeError("TextEncoder.encodeInto expects a Uint8Array");
    }
    return writeUtf8(NativeString(input), destination, byteLength);
  };
  class TextEncoder {
    get encoding() { return "utf-8"; }
    encode(input = "") {
      const text = NativeString(input);
      const bytes = new NativeUint8Array(utf8Length(text));
      writeUtf8(text, bytes, apply(typedArrayByteLength, bytes, []));
      return bytes;
    }
    encodeInto(input, destination) { return encodeInto(input, destination); }
  }
  const copyBufferSource = (input, label) => {
    let buffer;
    let byteOffset = 0;
    let byteLength;
    if (isView(input)) {
      try {
        buffer = apply(typedArrayBuffer, input, []);
        byteOffset = apply(typedArrayByteOffset, input, []);
        byteLength = apply(typedArrayByteLength, input, []);
      } catch {
        try {
          buffer = apply(dataViewBuffer, input, []);
          byteOffset = apply(dataViewByteOffset, input, []);
          byteLength = apply(dataViewByteLength, input, []);
        } catch {
          throw new NativeTypeError("Web Crypto expects an ArrayBuffer or view");
        }
      }
    } else {
      try { byteLength = apply(arrayBufferByteLength, input, []); }
      catch { throw new NativeTypeError("Web Crypto expects an ArrayBuffer or view"); }
      buffer = input;
    }
    if (byteLength > MAX_CRYPTO_BYTES) throw new NativeTypeError("Web Crypto " + label + " exceeds the 64 KiB limit");
    let source;
    try { source = new NativeUint8Array(buffer, byteOffset, byteLength); }
    catch { throw new NativeTypeError("Web Crypto input is detached or invalid"); }
    const copy = new NativeUint8Array(byteLength);
    for (let index = 0; index < byteLength; index += 1) copy[index] = source[index];
    return copy;
  };
  const bytesToString = (bytes) => {
    let value = "";
    for (let index = 0; index < apply(typedArrayByteLength, bytes, []); index += 1) {
      value += apply(stringFromCharCode, NativeString, [bytes[index]]);
    }
    return value;
  };
  const performCrypto = (request) => new NativePromise((resolve, reject) => {
    let hostTask;
    try { hostTask = hostCryptoOperation(request); }
    catch { reject(new NativeError("Web Crypto operation failed")); return; }
    try {
      apply(hostTask.then, hostTask, [
        (encoded) => {
          try {
            if (typeof encoded !== "string" || encoded.length > 1200000) throw new NativeError("invalid Web Crypto response");
            const result = jsonParse(encoded);
            if (result === null || typeof result !== "object" || result.ok !== true) throw new NativeError("Web Crypto operation failed");
            resolve(result);
          } catch { reject(new NativeError("Web Crypto operation failed")); }
        },
        () => reject(new NativeError("Web Crypto operation failed")),
      ]);
    } catch { reject(new NativeError("Web Crypto operation failed")); }
  });
  const cryptoKeyData = new WeakMap();
  const cryptoKeyToken = {};
  class CryptoKey {
    constructor(token, id, length) {
      if (token !== cryptoKeyToken) throw new NativeTypeError("CryptoKey cannot be constructed directly");
      apply(weakMapSet, cryptoKeyData, [this, id]);
      objectDefineProperties(this, {
        type: { value: "secret", enumerable: true },
        extractable: { value: false, enumerable: true },
        algorithm: { value: objectFreeze({ name: "AES-GCM", length }), enumerable: true },
        usages: { value: objectFreeze(["encrypt"]), enumerable: true },
      });
      objectFreeze(this);
    }
  }
  objectFreeze(CryptoKey.prototype);
  const localCryptoKey = (id, length) => new CryptoKey(cryptoKeyToken, id, length);
  const getCryptoKeyId = (key) => {
    try {
      const id = apply(weakMapGet, cryptoKeyData, [key]);
      return numberIsInteger(id) && id > 0 && id <= 8 ? id : null;
    } catch { return null; }
  };
  let nextCryptoKeyId = 0;
  const importKey = (format, keyData, algorithm, extractable, usages) => new NativePromise((resolve, reject) => {
    try { consumeCryptoOperation(); }
    catch { reject(new NativeRangeError("crypto operation budget exceeded")); return; }
    let raw;
    let id;
    try {
      if (format !== "raw" || algorithm === null || typeof algorithm !== "object" || algorithm.name !== "AES-GCM" || extractable !== false ||
          !arrayIsArray(usages) || usages.length !== 1 || usages[0] !== "encrypt" || nextCryptoKeyId >= 8) {
        throw new NativeTypeError("unsupported raw AES-GCM import");
      }
      raw = copyBufferSource(keyData, "key");
      const length = apply(typedArrayByteLength, raw, []);
      if (length !== 16 && length !== 24 && length !== 32) throw new NativeTypeError("invalid AES-GCM key length");
      id = ++nextCryptoKeyId;
    } catch {
      reject(new NativeTypeError("unsupported raw AES-GCM import"));
      return;
    }
    const request = objectCreate(null);
    request.op = "import";
    request.id = id;
    request.raw = bytesToString(raw);
    const task = performCrypto(jsonStringify(request));
    apply(promiseThen, task, [
      (result) => {
        if (result.id !== id || result.length !== apply(typedArrayByteLength, raw, []) * 8) {
          reject(new NativeError("Web Crypto operation failed"));
          return;
        }
        try { resolve(localCryptoKey(id, result.length)); }
        catch { reject(new NativeError("Web Crypto operation failed")); }
      },
      () => reject(new NativeError("Web Crypto operation failed")),
    ]);
  });
  const encrypt = (algorithm, key, data) => new NativePromise((resolve, reject) => {
    try { consumeCryptoOperation(); }
    catch { reject(new NativeRangeError("crypto operation budget exceeded")); return; }
    let id;
    let iv;
    let additionalData;
    let plaintext;
    let tagLength;
    try {
      if (algorithm === null || typeof algorithm !== "object" || algorithm.name !== "AES-GCM") {
        throw new NativeTypeError("only AES-GCM encryption is supported");
      }
      id = getCryptoKeyId(key);
      if (id === null) throw new NativeTypeError("invalid CryptoKey");
      iv = copyBufferSource(algorithm.iv, "IV");
      if (apply(typedArrayByteLength, iv, []) === 0) throw new NativeTypeError("AES-GCM IV must not be empty");
      additionalData = algorithm.additionalData === undefined
        ? new NativeUint8Array(0)
        : copyBufferSource(algorithm.additionalData, "additionalData");
      plaintext = copyBufferSource(data, "data");
      tagLength = algorithm.tagLength === undefined ? 128 : algorithm.tagLength;
      if (!numberIsInteger(tagLength) ||
          (tagLength !== 32 && tagLength !== 64 && tagLength !== 96 && tagLength !== 104 &&
           tagLength !== 112 && tagLength !== 120 && tagLength !== 128)) {
        throw new NativeTypeError("unsupported AES-GCM tag length");
      }
    } catch {
      reject(new NativeTypeError("unsupported AES-GCM encryption input"));
      return;
    }
    const request = objectCreate(null);
    request.op = "encrypt";
    request.id = id;
    request.iv = bytesToString(iv);
    request.additionalData = bytesToString(additionalData);
    request.data = bytesToString(plaintext);
    request.tagLength = tagLength;
    const task = performCrypto(jsonStringify(request));
    apply(promiseThen, task, [
      (result) => {
        if (typeof result.data !== "string" || result.data.length > MAX_CRYPTO_BYTES + 16) {
          reject(new NativeError("Web Crypto operation failed"));
          return;
        }
        const bytes = new NativeUint8Array(result.data.length);
        for (let index = 0; index < result.data.length; index += 1) {
          const code = apply(stringCharCodeAt, result.data, [index]);
          if (code > 255) {
            reject(new NativeError("Web Crypto operation failed"));
            return;
          }
          bytes[index] = code;
        }
        resolve(apply(typedArrayBuffer, bytes, []));
      },
      () => reject(new NativeError("Web Crypto operation failed")),
    ]);
  });
  const subtle = objectFreeze({ importKey, encrypt });
  const randomUUID = () => {
    const bytes = new NativeUint8Array(16);
    getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = "";
    for (let index = 0; index < bytes.length; index += 1) {
      const part = apply(numberToString, bytes[index], [16]);
      hex += part.length === 1 ? "0" + part : part;
    }
    return apply(stringSlice, hex, [0, 8]) + "-" + apply(stringSlice, hex, [8, 12]) + "-" +
      apply(stringSlice, hex, [12, 16]) + "-" + apply(stringSlice, hex, [16, 20]) + "-" + apply(stringSlice, hex, [20, 32]);
  };
  const crypto = objectFreeze({ getRandomValues, randomUUID, subtle });
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
    if (childRealm) throw new NativeTypeError("frame cookie writes are unsupported");
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
    if (childRealm) { reject(new NativeTypeError("frame network APIs are unsupported")); return; }
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
    if (timer.interval === undefined) { timers.delete(id); send({ type: "timer.clear", id }); }
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
    if (message.type === "frame.reply") {
      const task = pending.get(message.id);
      if (!task || task.kind !== "frame") return;
      pending.delete(message.id);
      if (message.error) task.reject(new NativeTypeError(String(message.error)));
      else task.resolve();
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
  const requestStates = new WeakMap();
  const getRequestState = (value) => apply(weakMapGet, requestStates, [value]);
  class Request {
    constructor(input, init = {}) {
      const source = input instanceof Request ? getRequestState(input) : undefined;
      if (source?.bodyUsed) throw new TypeError("Request body is already used");
      const rawUrl = source?.url ?? (typeof input === "string" ? input : input instanceof URL ? input.href : undefined);
      if (typeof rawUrl !== "string") throw new TypeError("Request expects a URL string, URL, or Request");
      const options = init ?? {};
      const url = rawUrl;
      const method = String(options.method ?? source?.method ?? "GET").toUpperCase();
      const headers = new Headers(options.headers ?? source?.headers);
      const bodyOption = options.body;
      const body = bodyOption !== undefined ? bodyOption : source?.body ?? null;
      const credentials = options.credentials ?? source?.credentials ?? "same-origin";
      const redirect = options.redirect ?? source?.redirect ?? "follow";
      const mode = options.mode ?? source?.mode ?? "cors";
      if (credentials !== "same-origin") throw new TypeError("fetch credentials mode is not supported");
      if (redirect !== "follow") throw new TypeError("fetch redirect mode is not supported");
      if (options.mode !== undefined) throw new TypeError("fetch mode is not supported");
      if (body != null && typeof body !== "string" && !(body instanceof FormData)) throw new TypeError("Request supports string and FormData bodies only");
      if ((method === "GET" || method === "HEAD") && body != null) throw new TypeError("GET and HEAD cannot have a body");
      apply(weakMapSet, requestStates, [this, { url, method, headers, body, credentials, redirect, mode, bodyUsed: false }]);
      if (source && bodyOption === undefined && source.body != null) source.bodyUsed = true;
    }
    get url() { return getRequestState(this).url; }
    get method() { return getRequestState(this).method; }
    get headers() { return getRequestState(this).headers; }
    get body() { return getRequestState(this).body; }
    get credentials() { return getRequestState(this).credentials; }
    get redirect() { return getRequestState(this).redirect; }
    get mode() { return getRequestState(this).mode; }
    get bodyUsed() { return getRequestState(this).bodyUsed; }
    clone() {
      const state = getRequestState(this);
      if (state.bodyUsed) throw new TypeError("Request body is already used");
      const clone = objectCreate(Request.prototype);
      apply(weakMapSet, requestStates, [clone, { ...state, headers: new Headers(state.headers), bodyUsed: false }]);
      return clone;
    }
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
      const requestInput = input && typeof input === "object" && !(input instanceof Request) && !(input instanceof URL) && typeof input.url === "string" ? input.url : input;
      const requestObject = new Request(requestInput, init);
      const state = getRequestState(requestObject);
      const { url, method } = state;
      const headers = new Headers(state.headers);
      let body = null;
      if (state.body instanceof FormData) {
        if (method === "GET" || method === "HEAD") throw new TypeError("GET and HEAD cannot have a body");
        const multipart = serializeFormData(state.body);
        body = multipart.bytes;
        if (!headers.has("content-type")) headers.set("content-type", multipart.contentType);
      } else if (state.body != null) {
        if (typeof state.body !== "string") throw new TypeError("fetch supports string and FormData request bodies only");
        body = state.body;
      }
      if ((method === "GET" || method === "HEAD") && body !== null) throw new TypeError("GET and HEAD cannot have a body");
      if (body !== null) state.bodyUsed = true;
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
    if (childRealm) throw new NativeTypeError("frame network APIs are unsupported");
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
  const bindEventHandlers = (target, types) => {
    for (const type of types) {
      let callback = null;
      let listener = null;
      Object.defineProperty(target, "on" + type, {
        enumerable: true,
        configurable: true,
        get: () => callback,
        set: (value) => {
          if (listener !== null) target.removeEventListener(type, listener);
          callback = typeof value === "function" ? value : null;
          listener = callback === null ? null : (event) => callback.call(target, event);
          if (listener !== null) target.addEventListener(type, listener);
        },
      });
    }
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
      bindEventHandlers(this, ["loadstart", "progress", "load", "error", "abort", "loadend"]);
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
  const location = {
    href: pageLocationData[0],
    origin: pageLocationData[1],
    protocol: pageLocationData[2],
    host: pageLocationData[3],
    hostname: pageLocationData[4],
    port: pageLocationData[5],
    pathname: pageLocationData[6],
    search: pageLocationData[7],
    hash: pageLocationData[8],
  };
  if (childRealm) {
    for (const key of Object.keys(location)) {
      const value = location[key]; Object.defineProperty(location, key, { get: () => value, set: () => { throw new NativeTypeError("frame navigation is unsupported"); }, enumerable: true });
    }
  }
  Object.freeze(location);
  Object.defineProperty(document, "location", childRealm
    ? { get: () => location, set: () => { throw new NativeTypeError("frame navigation is unsupported"); }, enumerable: true }
    : { value: location, enumerable: true });
  Object.defineProperty(document, "referrer", { value: initialReferrer, enumerable: true });
  document.loadScript = (url) => request("script", String(url), "GET", new Headers([["accept", "text/javascript, application/javascript, */*"]]), null).then((value) => {
    if (value.status < 200 || value.status >= 300) throw new TypeError("script load failed with HTTP " + value.status);
    return undefined;
  });
  // Only external async classic scripts, not a DOM. New ceilings do not enlarge network budgets.
  const MAX_SCRIPT_NODES = 32;
  const MAX_SCRIPT_ATTRIBUTE_BYTES = 16 * 1024;
  const scriptNodes = new WeakMap();
  let scriptNodeCount = 0;
  let scriptAttributeBytes = 0;
  const scriptAttributeNames = ["src", "type", "integrity", "crossorigin", "async", "defer", "nomodule", "id", "nonce"];
  const appendScript = (element) => {
    const frameState = frameNodes.get(element);
    if (frameState !== undefined) return appendFrame(element, frameState);
    const state = scriptNodes.get(element);
    if (state === undefined) throw new NativeTypeError("BrowserMock appendChild accepts script elements only");
    if (state.started) return element;
    if (childRealm) throw new NativeTypeError("frame dynamic scripts are unsupported");
    const src = state.attributes.get("src");
    if (!src) throw new NativeTypeError("BrowserMock requires an external script src; inline scripts are unsupported");
    state.started = true;
    apply(promiseThen, loadExternalScript(src), [
      () => element.dispatchEvent(new Event("load")),
      () => element.dispatchEvent(new Event("error")),
    ]);
    return element;
  };
  // Capture the existing loader: replies execute in this VM before its promise resolves.
  const loadExternalScript = document.loadScript;
  document.createElement = (name, ...options) => {
    if (NativeString(name).toLowerCase() === "iframe" && options.length === 0) return createFrame();
    if (NativeString(name).toLowerCase() !== "script" || options.length !== 0) {
      throw new NativeTypeError("BrowserMock createElement supports script only, without options");
    }
    if (scriptNodeCount >= MAX_SCRIPT_NODES) throw new NativeRangeError("script element budget exceeded (32 nodes)");
    if (!consumeBudget("node", 1)) throw new NativeRangeError("script element budget exceeded (32 nodes)");
    scriptNodeCount += 1;
    const attributes = new Map();
    const element = makeEventTarget({ tagName: "SCRIPT", nodeName: "SCRIPT" });
    const setAttribute = (name, value) => {
      const key = NativeString(name).toLowerCase();
      if (!scriptAttributeNames.includes(key)) throw new NativeTypeError("unsupported script attribute: " + key);
      const text = NativeString(value);
      if (text.length > MAX_URL_INPUT_LENGTH) throw new NativeRangeError("script attribute exceeds 8192 characters");
      const bytes = utf8Length(key) + utf8Length(text);
      if (scriptAttributeBytes + bytes > MAX_SCRIPT_ATTRIBUTE_BYTES) throw new NativeRangeError("script attribute budget exceeded (16 KiB)");
      if (key === "type" && !["", "text/javascript", "application/javascript"].includes(text.trim().toLowerCase())) {
        throw new NativeTypeError("module and non-JavaScript scripts are unsupported");
      }
      if (key === "integrity" && text !== "") throw new NativeTypeError("script integrity is unsupported; SRI is not checked");
      if (key === "crossorigin") throw new NativeTypeError("script crossorigin modes are unsupported");
      if (key === "defer" || key === "nomodule") throw new NativeTypeError("ordered and conditional script modes are unsupported");
      if (!consumeBudget("attribute", bytes)) throw new NativeRangeError("script attribute budget exceeded (16 KiB)");
      scriptAttributeBytes += bytes;
      attributes.set(key, text);
    };
    element.setAttribute = setAttribute;
    element.getAttribute = (name) => attributes.get(NativeString(name).toLowerCase()) ?? null;
    element.removeAttribute = (name) => { attributes.delete(NativeString(name).toLowerCase()); };
    for (const key of ["src", "type", "integrity", "crossOrigin", "id", "nonce"]) {
      const attribute = key.toLowerCase();
      Object.defineProperty(element, key, {
        enumerable: true,
        get: () => {
          const value = attributes.get(attribute);
          return key === "src" && value ? new URL(value, initialUrl).href : value ?? (key === "crossOrigin" ? null : "");
        },
        set: (value) => setAttribute(attribute, value),
      });
    }
    for (const key of ["async", "defer", "noModule"]) {
      Object.defineProperty(element, key, {
        enumerable: true,
        get: () => key === "async",
        set: (value) => {
          if (Boolean(value) !== (key === "async")) throw new NativeTypeError("only async classic scripts are supported");
          if (key === "async") setAttribute("async", "");
        },
      });
    }
    for (const key of ["text", "textContent", "innerHTML"]) {
      Object.defineProperty(element, key, {
        enumerable: true,
        get: () => "",
        set: (value) => {
          if (NativeString(value) !== "") throw new NativeTypeError("inline script content is unsupported");
        },
      });
    }
    bindEventHandlers(element, ["load", "error"]);
    scriptNodes.set(element, { attributes, started: false });
    return objectFreeze(element);
  };
  const unsupportedFrameOperation = () => { throw new NativeTypeError("frame messaging and navigation are unsupported"); };
  const opaqueWindow = () => objectFreeze({ postMessage: unsupportedFrameOperation });
  const frameNodes = new WeakMap();
  const appendFrame = (element, state) => {
    if (state.started) return element;
    if (!state.src) throw new NativeTypeError("frame requires an HTTP(S) src");
    state.started = true;
    const id = ++nextRequestId;
    const task = new NativePromise((resolve, reject) => {
      pending.set(id, { resolve, reject, kind: "frame" });
      if (!postLine(jsonStringify({ type: "frame.load", id, url: state.src }))) {
        pending.delete(id); reject(new NativeTypeError("frame IPC budget exceeded"));
      }
    });
    apply(promiseThen, task, [() => {
      state.window = opaqueWindow();
      element.dispatchEvent(new Event("load"));
    }, () => {
      // Denials expose only an error event and no child identity or fake SDK message.
      element.dispatchEvent(new Event("error"));
    }]);
    return element;
  };
  const createFrame = () => {
    if (childRealm) throw new NativeTypeError("nested frames are unsupported");
    if (!consumeBudget("frame", 1)) throw new NativeRangeError("frame budget exceeded (4 frames)");
    if (!consumeBudget("node", 1)) throw new NativeRangeError("script element budget exceeded (32 nodes)");
    const state = { src: "", started: false, window: null };
    const attributes = new Map();
    const element = makeEventTarget({ tagName: "IFRAME", nodeName: "IFRAME" });
    const setAttribute = (name, value) => {
      const key = NativeString(name).toLowerCase();
      if (!["src", "id", "name"].includes(key)) throw new NativeTypeError("unsupported frame attribute: " + key);
      if (state.started) throw new NativeTypeError("frame navigation is unsupported");
      const text = requireUrlString(value);
      if (key === "src") {
        const url = new URL(text, initialUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new NativeTypeError("frame requires an HTTP(S) src");
        if (/^https?:\/\/[^/]*@/i.test(url.href)) throw new NativeTypeError("frame URL credentials are unsupported");
        state.src = url.href;
      }
      if (!consumeBudget("attribute", utf8Length(key) + utf8Length(text))) throw new NativeRangeError("script attribute budget exceeded (16 KiB)");
      attributes.set(key, text);
    };
    element.setAttribute = setAttribute;
    element.getAttribute = (name) => attributes.get(NativeString(name).toLowerCase()) ?? null;
    for (const key of ["src", "id", "name"]) Object.defineProperty(element, key, {
      enumerable: true, get: () => key === "src" ? state.src : attributes.get(key) ?? "", set: (value) => setAttribute(key, value),
    });
    for (const key of ["srcdoc", "sandbox", "credentialless", "crossOrigin", "referrerPolicy"]) Object.defineProperty(element, key, {
      set: () => { throw new NativeTypeError("unsupported frame attribute: " + key); },
    });
    Object.defineProperties(element, {
      contentWindow: { get: () => state.window },
      contentDocument: { get: () => null },
    });
    bindEventHandlers(element, ["load", "error"]);
    frameNodes.set(element, state);
    return objectFreeze(element);
  };
  document.head = objectFreeze({ appendChild: appendScript });
  document.body = objectFreeze({ appendChild: appendScript });
  const navigator = Object.freeze({ userAgent, language: languages[0] ?? "", languages, cookieEnabled: true, webdriver: false });
  const console = Object.freeze({ log() {}, warn() {}, error() {}, info() {} });
  const window = makeEventTarget(globalThis);
  Object.assign(window, { document, location, navigator, console, performance, crypto, TextEncoder, CryptoKey, fetch, XMLHttpRequest, setTimeout, clearTimeout, setInterval, clearInterval, Headers, Request, Response, Event, ProgressEvent, Blob, FileReader, FormData, URL, URLSearchParams });
  Object.defineProperty(window, "location", childRealm
    ? { get: () => location, set: unsupportedFrameOperation, enumerable: true, configurable: false }
    : { value: location, enumerable: true, writable: false, configurable: false });
  Object.defineProperty(window, "isSecureContext", { value: pageLocationData[9], enumerable: true });
  window.window = window; window.self = window; window.globalThis = window;
  if (childRealm) {
    Object.defineProperties(window, { parent: { value: opaqueWindow() }, top: { value: opaqueWindow() }, postMessage: { value: unsupportedFrameOperation } });
  }
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
  try { return typeof bytes === "string" ? new TextDecoder().decode(Buffer.from(bytes, "latin1")) : null; }
  catch { return null; }
};
const { randomFillSync: hostRandomFillSync, webcrypto: hostWebCrypto } = require("node:crypto");
const hostUrlOperation = (() => {
  const { URL: NodeURL, URLSearchParams: NodeURLSearchParams } = require("node:url");
  const MAX_URL_INPUT_LENGTH = 8192;
  const MAX_URL_RESULT_BYTES = 65536;
  const serialize = (value) => {
    const encoded = JSON.stringify(value);
    return Buffer.byteLength(encoded, "utf8") <= MAX_URL_RESULT_BYTES ? encoded : null;
  };
  return (operation, input, first, second) => {
    try {
      if ([operation, input, first, second].some((value) => typeof value !== "string" || value.length > MAX_URL_INPUT_LENGTH)) return null;
      let result;
      if (operation === "parse" || operation === "parse-base") {
        const url = operation === "parse" ? new NodeURL(input) : new NodeURL(input, first);
        result = [url.href, url.origin, url.protocol, url.host, url.hostname, url.port, url.pathname, url.search, url.hash];
      } else if (operation === "params:get") {
        result = [new NodeURLSearchParams(input).get(first)];
      } else return null;
      return serialize(result);
    } catch { return null; }
  };
})();
const hostPageLocation = (inputUrl) => {
  const href = String(inputUrl);
  try {
    const { URL: NodeURL } = require("node:url");
    const url = new NodeURL(href);
    const hostname = url.hostname.toLowerCase();
    const localHostname = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
    const ipv4 = localHostname.split(".");
    const loopbackIpv4 = ipv4.length === 4 && ipv4[0] === "127" &&
      ipv4.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
    const loopback = localHostname === "localhost" || localHostname.endsWith(".localhost") ||
      loopbackIpv4 || localHostname === "[::1]" || localHostname === "::1";
    return JSON.stringify([
      url.href, url.origin, url.protocol, url.host, url.hostname, url.port,
      url.pathname, url.search, url.hash,
      url.protocol === "https:" || (url.protocol === "http:" && loopback),
    ]);
  } catch {
    return JSON.stringify([href, "null", "", "", "", "", "", "", "", false]);
  }
};
const MAX_RANDOM_BYTES = 65536;
const hostRandomBytes = (byteLength) => {
  try {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_RANDOM_BYTES) return null;
    return hostRandomFillSync(Buffer.allocUnsafe(byteLength)).toString("latin1");
  } catch { return null; }
};
const MAX_HOST_CRYPTO_BYTES = 65536;
const MAX_HOST_CRYPTO_KEYS = 8;
const MAX_HOST_CRYPTO_CALLS = 64;
const hostCryptoKeys = new Map();
const hostCryptoKeyIds = new Set();
let hostCryptoCalls = 0;
let nextOwnedCryptoKeyId = 0;
const CRYPTO_FAILURE = '{"ok":false}';
const hostCryptoOperation = (encoded) => {
  const fail = () => Promise.resolve(CRYPTO_FAILURE);
  try {
    if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > 1200000 || hostCryptoCalls >= MAX_HOST_CRYPTO_CALLS) return fail();
    hostCryptoCalls += 1;
    const request = JSON.parse(encoded);
    if (request.op === "import") {
      if (!Number.isSafeInteger(request.id) || request.id < 1 || request.id > MAX_HOST_CRYPTO_KEYS ||
          hostCryptoKeyIds.size >= MAX_HOST_CRYPTO_KEYS || hostCryptoKeyIds.has(request.id) ||
          typeof request.raw !== "string" || request.raw.length > MAX_HOST_CRYPTO_BYTES) return fail();
      const raw = Buffer.from(request.raw, "latin1");
      if (raw.length !== 16 && raw.length !== 24 && raw.length !== 32) return fail();
      hostCryptoKeyIds.add(request.id);
      return hostWebCrypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]).then(
        (key) => {
          try {
            if (finished) {
              hostCryptoKeyIds.delete(request.id);
              return CRYPTO_FAILURE;
            }
            hostCryptoKeys.set(request.id, key);
            return JSON.stringify({ ok: true, id: request.id, length: raw.length * 8 });
          } catch {
            hostCryptoKeyIds.delete(request.id);
            return CRYPTO_FAILURE;
          }
        },
        () => {
          hostCryptoKeyIds.delete(request.id);
          return CRYPTO_FAILURE;
        },
      );
    }
    if (request.op !== "encrypt" || !Number.isSafeInteger(request.id) || !hostCryptoKeys.has(request.id) ||
        typeof request.iv !== "string" || request.iv.length === 0 || request.iv.length > MAX_HOST_CRYPTO_BYTES ||
        typeof request.additionalData !== "string" || request.additionalData.length > MAX_HOST_CRYPTO_BYTES ||
        typeof request.data !== "string" || request.data.length > MAX_HOST_CRYPTO_BYTES ||
        (request.tagLength !== 32 && request.tagLength !== 64 && request.tagLength !== 96 &&
         request.tagLength !== 104 && request.tagLength !== 112 && request.tagLength !== 120 && request.tagLength !== 128)) return fail();
    const result = hostWebCrypto.subtle.encrypt({
      name: "AES-GCM",
      iv: Buffer.from(request.iv, "latin1"),
      additionalData: Buffer.from(request.additionalData, "latin1"),
      tagLength: request.tagLength,
    }, hostCryptoKeys.get(request.id), Buffer.from(request.data, "latin1"));
    return result.then(
      (ciphertext) => {
        try {
          const value = JSON.stringify({ ok: true, data: Buffer.from(ciphertext).toString("latin1") });
          return Buffer.byteLength(value, "utf8") <= 400000 ? value : CRYPTO_FAILURE;
        } catch { return CRYPTO_FAILURE; }
      },
      () => CRYPTO_FAILURE,
    );
  } catch { return fail(); }
};
const MAX_INPUT_LINE_BYTES = ${limits.maxInputLineBytes};
const MAX_CONTROL_INPUT_LINE_BYTES = ${limits.maxControlInputLineBytes};
const MAX_OUTPUT_LINE_BYTES = ${limits.maxOutputLineBytes};
const MAX_OUTPUT_BYTES = ${limits.maxOutputBytes};
let outputBytes = 0;
const pendingKinds = new Map();
const frames = new Map();
const receivers = new WeakMap();
const timerOwners = new Map();
let nextOuterTimerId = 0;
let nextFrameId = 0;
const budget = { node: 0, attribute: 0, frame: 0, crypto: 0 };
const ceilings = { node: 32, attribute: 16384, frame: 4, crypto: 64 };
const consumeBudget = (kind, amount) => {
  if (!Object.hasOwn(ceilings, kind) || !Number.isSafeInteger(amount) || amount < 0 || budget[kind] + amount > ceilings[kind]) return false;
  budget[kind] += amount; return true;
};
let rootInput;
let deadline;
const run = (source, realm) => vm.runInContext(source, realm, { timeout: Math.max(1, Math.ceil(deadline - hostMonotonicNow())) });
const deliverTo = (realm, line) => {
  realm.__incoming = line; realm.__dispatch = receivers.get(realm);
  try { run("{ const receive = __dispatch; const incoming = __incoming; delete globalThis.__dispatch; delete globalThis.__incoming; receive(incoming); }", realm); }
  finally { delete realm.__incoming; delete realm.__dispatch; }
};
let context;
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
  frames.clear(); timerOwners.clear();
  hostCryptoKeys.clear();
  hostCryptoKeyIds.clear();
  process.stdout.end(JSON.stringify({ type: "result", output }) + "\n", () => process.exit(0));
};
const post = (line, owner = context) => {
  try {
    let bytes = Buffer.byteLength(line) + 1;
    if (typeof line !== "string" || bytes - 1 > MAX_OUTPUT_LINE_BYTES || outputBytes + bytes > MAX_OUTPUT_BYTES) return false;
    const message = JSON.parse(line);
    if (message.type === "frame.load") {
      if (owner !== context || ++nextFrameId > 4) return false;
      frames.set(message.id, { id: nextFrameId, parent: owner, url: message.url });
    }
    if (message.type === "timer.set") {
      let entry = [...timerOwners.entries()].find(([, value]) => value.owner === owner && value.localId === message.id);
      if (!entry) {
        if (timerOwners.size >= ${limits.maxTimers}) { writeFinal({ ok: false, reason: "script timer budget exceeded" }); return false; }
        entry = [++nextOuterTimerId, { owner, localId: message.id }]; timerOwners.set(...entry);
      }
      message.id = entry[0]; line = JSON.stringify(message);
    }
    if (message.type === "timer.clear") {
      const entry = [...timerOwners.entries()].find(([, value]) => value.owner === owner && value.localId === message.id);
      if (!entry) return true;
      timerOwners.delete(entry[0]); message.id = entry[0]; line = JSON.stringify(message);
    }
    if (message.type === "network") {
      if (owner !== context) return false;
      pendingKinds.set(message.id, message.kind);
    }
    if (message.type === "cookie.write" && owner !== context) return false;
    bytes = Buffer.byteLength(line) + 1;
    if (bytes - 1 > MAX_OUTPUT_LINE_BYTES || outputBytes + bytes > MAX_OUTPUT_BYTES) return false;
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
    if (message.type === "timer.fire") {
      const entry = timerOwners.get(message.id);
      if (!entry) return;
      message.id = entry.localId;
      // Retain ownership for interval re-registration; the VM clears one-shots.
      deliverTo(entry.owner, JSON.stringify(message)); return;
    }
    if (message.type === "frame.reply") {
      const entry = frames.get(message.id);
      if (!entry || entry.child) throw new Error("invalid frame reply ownership");
      if (message.error) { frames.delete(message.id); deliverTo(context, JSON.stringify(message)); return; }
      const frame = message.frame;
      entry.source = Object.freeze({ url: frame.url, origin: frame.origin, cookie: frame.cookie });
      const parent = new URL(frame.parentUrl); parent.username = ""; parent.password = ""; parent.hash = "";
      const referrer = parent.origin === frame.origin ? parent.href : parent.origin + "/";
      entry.child = createRealm({ ...rootInput, url: frame.url, cookie: frame.cookie ?? "", referrer, authoritativeCookies: true }, true);
      const child = entry.child;
      const execute = async () => { for (const source of frame.scripts) await run(source, child); };
      execute().then(() => {
        if (!finished) {
          try { deliverTo(context, JSON.stringify({ type: "frame.reply", id: message.id })); }
          catch (cause) { writeFinal({ ok: false, reason: safeMessage(cause) }); }
        }
      }, (cause) => writeFinal({ ok: false, reason: "frame script failed: " + safeMessage(cause) }));
      return;
    }
    if (message.type === "reply") {
      const kind = pendingKinds.get(message.id);
      pendingKinds.delete(message.id);
      if (message.ok && kind === "script") {
        if (!message.response.error && message.response.status >= 200 && message.response.status < 300) {
          try { run(message.response.body, context); }
          catch (cause) {
            message = { type: "reply", id: message.id, ok: false, error: "loaded script failed: " + safeMessage(cause) };
          }
        }
        if (message.ok) message.response.body = "";
      }
    }
    deliverTo(context, JSON.stringify(message));
  } catch (cause) { writeFinal({ ok: false, reason: safeMessage(cause) }); }
};
const createRealm = (input, childRealm) => {
  // Local handles never name another realm's native keys; the eight-key cap stays global.
  const ownedKeys = new Map();
  const realmCryptoOperation = (encoded) => {
    try {
      const request = JSON.parse(encoded);
      const localId = request.id;
      if (request.op === "import") {
        if (!Number.isSafeInteger(localId) || localId < 1 || ownedKeys.has(localId)) return Promise.resolve(CRYPTO_FAILURE);
        ownedKeys.set(localId, ++nextOwnedCryptoKeyId);
      }
      const nativeId = ownedKeys.get(localId);
      if (nativeId === undefined) return Promise.resolve(CRYPTO_FAILURE);
      request.id = nativeId;
      return hostCryptoOperation(JSON.stringify(request)).then((reply) => {
        try {
          const result = JSON.parse(reply);
          if (result.ok && request.op === "import") result.id = localId;
          return JSON.stringify(result);
        } catch { return CRYPTO_FAILURE; }
      });
    } catch { return Promise.resolve(CRYPTO_FAILURE); }
  };
  const pageLocation = hostPageLocation(String(input.url));
  const sandbox = Object.assign(Object.create(null), {
    __post: (line) => post(line, realm),
    __childRealm: childRealm,
    __consumeBudget: consumeBudget,
    __urlOperation: hostUrlOperation,
    __pageUrl: String(input.url),
    __pageLocation: pageLocation,
    __referrer: String(input.referrer),
    __cookie: String(input.cookie),
    __userAgent: String(input.userAgent),
    __languages: JSON.stringify(input.languages ?? ["en-US"]),
    __authoritativeCookies: input.authoritativeCookies,
    __performanceNow: hostMonotonicNow,
    __performanceTimeOrigin: hostTimeOrigin,
    __randomBytes: hostRandomBytes,
    __cryptoOperation: realmCryptoOperation,
    __encodeBlobText: hostEncodeBlobText,
    __decodeBlobText: hostDecodeBlobText,
  });
  const realm = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  run(bootstrap, realm);
  delete sandbox.__post;
  delete sandbox.__urlOperation;
  delete sandbox.__pageUrl;
  delete sandbox.__pageLocation;
  delete sandbox.__referrer;
  delete sandbox.__cookie;
  delete sandbox.__userAgent;
  delete sandbox.__languages;
  receivers.set(realm, run("__receive", realm));
  delete sandbox.__receive;
  delete sandbox.__performanceNow;
  delete sandbox.__performanceTimeOrigin;
  delete sandbox.__randomBytes;
  delete sandbox.__cryptoOperation;
  delete sandbox.__encodeBlobText;
  delete sandbox.__decodeBlobText;
  if (childRealm) { delete sandbox.__cookieSnapshot; delete sandbox.__cookieFlush; delete sandbox.__safeMessage; }
  return realm;
};
const start = (input) => {
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > ${limits.maxTimeoutMs}) throw new Error("invalid script evaluation timeout");
  rootInput = input; deadline = hostMonotonicNow() + input.timeoutMs;
  setTimeout(() => writeFinal({ ok: false, reason: "script evaluation timed out" }), Math.max(1, Math.ceil(deadline - hostMonotonicNow())));
  context = createRealm(input, false);
  const wrapper = "(async function () {\n" +
    "  const snapshot = __cookieSnapshot; const flush = __cookieFlush; const describe = __safeMessage;\n" +
    "  delete globalThis.__cookieSnapshot; delete globalThis.__cookieFlush; delete globalThis.__safeMessage;\n" +
    "  try { const value = await (async function () {\n" + input.source + "\n})(); await flush();\n" +
    "    const state = JSON.parse(snapshot()); if (state.error) return JSON.stringify({ ok: false, reason: state.error });\n" +
    "    return JSON.stringify({ ok: true, value: String(value == null ? \"\" : value), setCookies: state.setCookies });\n" +
    "  } catch (cause) { try { await flush(); } catch (flushCause) { cause = flushCause; } const state = JSON.parse(snapshot()); return JSON.stringify({ ok: false, reason: describe(cause), setCookies: state.setCookies }); }\n" +
    "})()";
  try {
    Promise.resolve(run(wrapper, context)).then((encoded) => {
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
