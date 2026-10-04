const _QRErrorCorrectLevel = { L: 1, M: 0, Q: 3, H: 2 }

const _QRMath = (() => {
  const EXP = new Array(256), LOG = new Array(256)
  for (let i = 0; i < 8; i++) EXP[i] = 1 << i
  for (let i = 8; i < 256; i++) EXP[i] = EXP[i-4] ^ EXP[i-5] ^ EXP[i-6] ^ EXP[i-8]
  for (let i = 0; i < 255; i++) LOG[EXP[i]] = i
  return {
    glog: n => { if (n < 1) throw new Error('glog(' + n + ')'); return LOG[n] },
    gexp: n => EXP[((n % 255) + 255) % 255],
  }
})()

class _QRPoly {
  constructor(num, shift) {
    let o = 0; while (o < num.length && num[o] === 0) o++
    this.num = new Array(num.length - o + shift)
    for (let i = 0; i < num.length - o; i++) this.num[i] = num[i + o]
  }
  get(i) { return this.num[i] }
  getLength() { return this.num.length }
  multiply(e) {
    const n = new Array(this.getLength() + e.getLength() - 1).fill(0)
    for (let i = 0; i < this.getLength(); i++)
      for (let j = 0; j < e.getLength(); j++)
        n[i+j] ^= _QRMath.gexp(_QRMath.glog(this.get(i)) + _QRMath.glog(e.get(j)))
    return new _QRPoly(n, 0)
  }
  mod(e) {
    if (this.getLength() - e.getLength() < 0) return this
    const r = _QRMath.glog(this.get(0)) - _QRMath.glog(e.get(0))
    const n = this.num.slice()
    for (let i = 0; i < e.getLength(); i++) n[i] ^= _QRMath.gexp(_QRMath.glog(e.get(i)) + r)
    return new _QRPoly(n, 0).mod(e)
  }
}

const _RS_TABLE = [
  [1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],
  [1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],
  [1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],
  [2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],
  [2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],
  [4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],
  [4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],
  [5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],[5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],
  [1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],
  [3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],
  [4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],
  [4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],
  [8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],
  [8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],
  [7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],
  [13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],
  [17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],
  [12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],
  [17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],
  [20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16],
]

class _QRRSBlock {
  constructor(t, d) { this.totalCount = t; this.dataCount = d }
  static get(typeNumber, ecLevel) {
    const t = _RS_TABLE[(typeNumber - 1) * 4 + [1,0,3,2][ecLevel]]
    const list = []
    for (let i = 0; i < t.length; i += 3)
      for (let j = 0; j < t[i]; j++) list.push(new _QRRSBlock(t[i+1], t[i+2]))
    return list
  }
}

class _QRBitBuf {
  constructor() { this.buffer = []; this.length = 0 }
  get(i) { return ((this.buffer[Math.floor(i/8)] >>> (7 - i%8)) & 1) === 1 }
  put(num, len) { for (let i = 0; i < len; i++) this.putBit(((num >>> (len-i-1)) & 1) === 1) }
  getLengthInBits() { return this.length }
  putBit(bit) {
    const bi = Math.floor(this.length/8)
    if (this.buffer.length <= bi) this.buffer.push(0)
    if (bit) this.buffer[bi] |= 0x80 >>> (this.length % 8)
    this.length++
  }
}

class _QRCode {
  constructor(typeNumber, ecLevel) {
    this.typeNumber = typeNumber; this.errorCorrectLevel = ecLevel
    this.modules = null; this.moduleCount = 0; this.dataCache = null; this.dataList = []
  }
  addData(data) {
    const obj = { mode: 4, data, parsedData: [] }
    const d = unescape(encodeURIComponent(data))
    for (let i = 0; i < d.length; i++) obj.parsedData.push(d.charCodeAt(i))
    obj.getLength = () => obj.parsedData.length
    obj.write = buf => { for (let i = 0; i < obj.parsedData.length; i++) buf.put(obj.parsedData[i], 8) }
    this.dataList.push(obj); this.dataCache = null
  }
  isDark(r, c) { return this.modules[r][c] }
  getModuleCount() { return this.moduleCount }
  make() { this._make(false, this._bestMask()) }
  _make(test, mask) {
    if (this.typeNumber < 1) {
      let t = 1
      for (; t < 40; t++) {
        const rs = _QRRSBlock.get(t, this.errorCorrectLevel)
        const buf = new _QRBitBuf()
        let total = rs.reduce((s,b) => s + b.dataCount, 0)
        for (const d of this.dataList) { buf.put(d.mode, 4); buf.put(d.getLength(), this._lenBits(d.mode, t)); d.write(buf) }
        if (buf.getLengthInBits() <= total * 8) break
      }
      this.typeNumber = t
    }
    this.moduleCount = this.typeNumber * 4 + 17
    this.modules = Array.from({length: this.moduleCount}, () => new Array(this.moduleCount).fill(null))
    this._probe(0, 0); this._probe(this.moduleCount-7, 0); this._probe(0, this.moduleCount-7)
    this._adjust(); this._timing(); this._typeInfo(test, mask)
    if (this.typeNumber >= 7) this._typeNum(test)
    if (!this.dataCache) this.dataCache = this._buildData()
    this._map(this.dataCache, mask)
  }
  _probe(row, col) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      if (row+r < 0 || this.moduleCount <= row+r || col+c < 0 || this.moduleCount <= col+c) continue
      this.modules[row+r][col+c] = (0<=r&&r<=6&&(c===0||c===6))||(0<=c&&c<=6&&(r===0||r===6))||(2<=r&&r<=4&&2<=c&&c<=4)
    }
  }
  _bestMask() {
    let min = 0, pat = 0
    for (let i = 0; i < 8; i++) { this._make(true, i); const lp = this._lostPoint(); if (i===0||min>lp){min=lp;pat=i} }
    return pat
  }
  _timing() {
    for (let r = 8; r < this.moduleCount-8; r++) if (this.modules[r][6]===null) this.modules[r][6] = r%2===0
    for (let c = 8; c < this.moduleCount-8; c++) if (this.modules[6][c]===null) this.modules[6][c] = c%2===0
  }
  _adjust() {
    const pos = this._patPos()
    for (let i = 0; i < pos.length; i++) for (let j = 0; j < pos.length; j++) {
      const row = pos[i], col = pos[j]
      if (this.modules[row][col] !== null) continue
      for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++)
        this.modules[row+r][col+c] = r===-2||r===2||c===-2||c===2||(r===0&&c===0)
    }
  }
  _typeNum(test) {
    const bits = this._bchTypeNum(this.typeNumber)
    for (let i = 0; i < 18; i++) {
      const m = !test && ((bits>>i)&1)===1
      this.modules[Math.floor(i/3)][i%3+this.moduleCount-8-3] = m
      this.modules[i%3+this.moduleCount-8-3][Math.floor(i/3)] = m
    }
  }
  _typeInfo(test, mask) {
    const bits = this._bchTypeInfo((this.errorCorrectLevel<<3)|mask)
    for (let i = 0; i < 15; i++) {
      const m = !test && ((bits>>i)&1)===1
      if (i<6) this.modules[i][8]=m; else if (i<8) this.modules[i+1][8]=m; else this.modules[this.moduleCount-15+i][8]=m
      if (i<8) this.modules[8][this.moduleCount-i-1]=m; else if (i<9) this.modules[8][15-i]=m; else this.modules[8][15-i-1]=m
    }
    this.modules[this.moduleCount-8][8] = !test
  }
  _map(data, mask) {
    let inc = -1, row = this.moduleCount-1, bi = 7, by = 0
    const mf = [(i,j)=>(i+j)%2===0,(i)=>i%2===0,(_,j)=>j%3===0,(i,j)=>(i+j)%3===0,(i,j)=>(Math.floor(i/2)+Math.floor(j/3))%2===0,(i,j)=>(i*j)%2+(i*j)%3===0,(i,j)=>((i*j)%2+(i*j)%3)%2===0,(i,j)=>((i+j)%2+(i*j)%3)%2===0][mask]
    for (let col = this.moduleCount-1; col > 0; col -= 2) {
      if (col===6) col--
      while (true) {
        for (let c = 0; c < 2; c++) {
          if (this.modules[row][col-c]===null) {
            let dark = by < data.length && ((data[by]>>>bi)&1)===1
            if (mf(row,col-c)) dark=!dark
            this.modules[row][col-c]=dark; bi--
            if (bi===-1){by++;bi=7}
          }
        }
        row+=inc
        if (row<0||this.moduleCount<=row){row-=inc;inc=-inc;break}
      }
    }
  }
  _lostPoint() {
    const m = this.moduleCount; let lp = 0
    for (let r = 0; r < m; r++) for (let c = 0; c < m; c++) {
      let sc = 0; const dark = this.isDark(r, c)
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (r+dr<0||m<=r+dr||c+dc<0||m<=c+dc||(!dr&&!dc)) continue
        if (dark===this.isDark(r+dr,c+dc)) sc++
      }
      if (sc>5) lp+=3+sc-5
    }
    for (let r = 0; r < m-1; r++) for (let c = 0; c < m-1; c++) {
      let cnt=0
      if(this.isDark(r,c))cnt++;if(this.isDark(r+1,c))cnt++;if(this.isDark(r,c+1))cnt++;if(this.isDark(r+1,c+1))cnt++
      if(cnt===0||cnt===4)lp+=3
    }
    for (let r = 0; r < m; r++) for (let c = 0; c < m-6; c++)
      if(this.isDark(r,c)&&!this.isDark(r,c+1)&&this.isDark(r,c+2)&&this.isDark(r,c+3)&&this.isDark(r,c+4)&&!this.isDark(r,c+5)&&this.isDark(r,c+6))lp+=40
    for (let c = 0; c < m; c++) for (let r = 0; r < m-6; r++)
      if(this.isDark(r,c)&&!this.isDark(r+1,c)&&this.isDark(r+2,c)&&this.isDark(r+3,c)&&this.isDark(r+4,c)&&!this.isDark(r+5,c)&&this.isDark(r+6,c))lp+=40
    let dc=0; for(let c=0;c<m;c++) for(let r=0;r<m;r++) if(this.isDark(r,c))dc++
    lp+=Math.abs(Math.floor(dc*100/m/m-50))/5*10
    return lp
  }
  _patPos() { return [[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]][this.typeNumber - 1] }
  _bchTypeInfo(d) { let x=d<<10; while(this._bchDigit(x)-this._bchDigit(0x537)>=0)x^=0x537<<(this._bchDigit(x)-this._bchDigit(0x537)); return((d<<10)|x)^0x5412 }
  _bchTypeNum(d) { let x=d<<12; while(this._bchDigit(x)-this._bchDigit(0x1F25)>=0)x^=0x1F25<<(this._bchDigit(x)-this._bchDigit(0x1F25)); return(d<<12)|x }
  _bchDigit(d) { let n=0; while(d!==0){n++;d>>>=1} return n }
  _lenBits(mode, t) {
    if(mode===1)return t<10?10:t<27?12:14
    if(mode===2)return t<10?9:t<27?11:13
    if(mode===4)return t<10?8:16
    if(mode===8)return t<10?8:t<27?10:12
  }
  _buildData() {
    const rs = _QRRSBlock.get(this.typeNumber, this.errorCorrectLevel)
    const buf = new _QRBitBuf()
    for (const d of this.dataList) { buf.put(d.mode,4); buf.put(d.getLength(),this._lenBits(d.mode,this.typeNumber)); d.write(buf) }
    const total = rs.reduce((s,b)=>s+b.dataCount,0)
    if (buf.getLengthInBits()>total*8) throw new Error('code length overflow')
    if (buf.getLengthInBits()+4<=total*8) buf.put(0,4)
    while(buf.getLengthInBits()%8!==0)buf.putBit(false)
    while(true){if(buf.getLengthInBits()>=total*8)break;buf.put(0xEC,8);if(buf.getLengthInBits()>=total*8)break;buf.put(0x11,8)}
    return this._buildBytes(buf, rs)
  }
  _buildBytes(buf, rs) {
    let off=0,maxDc=0,maxEc=0
    const dc=new Array(rs.length),ec=new Array(rs.length)
    for(let r=0;r<rs.length;r++){
      const dCnt=rs[r].dataCount,eCnt=rs[r].totalCount-dCnt
      maxDc=Math.max(maxDc,dCnt);maxEc=Math.max(maxEc,eCnt)
      dc[r]=new Array(dCnt); for(let i=0;i<dCnt;i++)dc[r][i]=0xff&buf.buffer[i+off]; off+=dCnt
      const rsp=this._ecPoly(eCnt),raw=new _QRPoly(dc[r],rsp.getLength()-1),mod=raw.mod(rsp)
      ec[r]=new Array(rsp.getLength()-1)
      for(let i=0;i<ec[r].length;i++){const mi=i+mod.getLength()-ec[r].length;ec[r][i]=mi>=0?mod.get(mi):0}
    }
    const total=rs.reduce((s,b)=>s+b.totalCount,0),data=new Array(total)
    let idx=0
    for(let i=0;i<maxDc;i++)for(let r=0;r<rs.length;r++)if(i<dc[r].length)data[idx++]=dc[r][i]
    for(let i=0;i<maxEc;i++)for(let r=0;r<rs.length;r++)if(i<ec[r].length)data[idx++]=ec[r][i]
    return data
  }
  _ecPoly(len){let a=new _QRPoly([1],0);for(let i=0;i<len;i++)a=a.multiply(new _QRPoly([1,_QRMath.gexp(i)],0));return a}
}

export function generateQR(input, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {} }
  opts = opts || {}
  const qr = new _QRCode(-1, _QRErrorCorrectLevel.L)
  qr.addData(input); qr.make()
  const BLACK = '\x1b[40m  \x1b[0m', WHITE = '\x1b[47m  \x1b[0m'
  let output = ''
  if (opts.small) {
    const mc = qr.getModuleCount(), md = qr.modules.slice()
    if (mc % 2 === 1) md.push(new Array(mc).fill(false))
    const p = {WW:'\u2588',WB:'\u2580',BW:'\u2584',BB:' '}
    output += p.BW.repeat(mc+3)+'\n'
    for (let r = 0; r < mc; r += 2) {
      output += p.WW
      for (let c = 0; c < mc; c++) {
        const t=md[r][c],b=md[r+1][c]
        output += (!t&&!b)?p.WW:(!t&&b)?p.WB:(t&&!b)?p.BW:p.BB
      }
      output += p.WW+'\n'
    }
    if (mc%2===0) output += p.WB.repeat(mc+3)
  } else {
    const border = WHITE.repeat(qr.getModuleCount()+2)
    output += border+'\n'
    qr.modules.forEach(row => { output += WHITE+row.map(c=>c?BLACK:WHITE).join('')+WHITE+'\n' })
    output += border
  }
  if (cb) cb(output); else console.log(output)
}
