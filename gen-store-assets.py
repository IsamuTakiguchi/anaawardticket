#!/usr/bin/env python3
# ストア掲載用の画像アセットを生成する。
import cairosvg, io
from PIL import Image

FONT = "IPAPGothic, IPAGothic, 'DejaVu Sans', sans-serif"
BLUE = "#00529b"; BLUED = "#003a73"; ORANGE = "#ef7d10"; PURPLE = "#7a3fb0"
BORDER = "#d6dbe2"; TEXT = "#1c2430"; MUTED = "#5b6675"; CARD = "#ffffff"

# --- ロゴを高解像度PNG化して data URI に -----------------------------------
logo_png = cairosvg.svg2png(url="icons/logo.svg", output_width=600, output_height=600)
import base64
LOGO_URI = "data:image/png;base64," + base64.b64encode(logo_png).decode()

def logo_img(x, y, size):
    return f'<image x="{x}" y="{y}" width="{size}" height="{size}" href="{LOGO_URI}" preserveAspectRatio="xMidYMid meet"/>'

def render(svg, w, h, out, flatten=True, bg="white"):
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=w, output_height=h)
    if flatten:
        im = Image.open(io.BytesIO(png)).convert("RGBA")
        base = Image.new("RGB", im.size, bg)
        base.paste(im, mask=im.split()[3])
        base.save(out)
    else:
        Image.open(io.BytesIO(png)).save(out)
    print("wrote", out, im_size(out))

def im_size(p):
    with Image.open(p) as i: return i.size

def T(x, y, s, size=16, fill=TEXT, weight="normal", anchor="start", family=FONT):
    return (f'<text x="{x}" y="{y}" font-family="{family}" font-size="{size}" '
            f'fill="{fill}" font-weight="{weight}" text-anchor="{anchor}">{s}</text>')

def box(x, y, w, h, r=6, fill=CARD, stroke=BORDER, sw=1.5):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>'

def caret(x, y):
    return f'<path d="M{x} {y} l8 0 l-4 5 z" fill="{MUTED}"/>'

def check(x, y, checked):
    b = f'<rect x="{x}" y="{y}" width="16" height="16" rx="3" fill="{BLUE if checked else "#fff"}" stroke="{BLUE if checked else BORDER}" stroke-width="1.5"/>'
    if checked:
        b += f'<path d="M{x+3} {y+8} l3.5 3.5 l6.5 -7" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
    return b

# ===========================================================================
# 1. ストアアイコン 128x128 (ロゴを中央・余白16px, 透過)
# ===========================================================================
icon_svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">{logo_img(8,8,112)}</svg>'
render(icon_svg, 128, 128, "store-assets/store-icon-128.png", flatten=False)

# ===========================================================================
# サイドパネル(検索タブ)のモックを描く関数
# ===========================================================================
def panel_search(ox, oy, W=430, H=624):
    s = []
    s.append(f'<g>')
    # カード
    s.append(f'<rect x="{ox}" y="{oy}" width="{W}" height="{H}" rx="14" fill="#fff" stroke="{BORDER}" stroke-width="1.5"/>')
    # ヘッダー
    s.append(f'<path d="M{ox} {oy+14} a14 14 0 0 1 14 -14 h{W-28} a14 14 0 0 1 14 14 v62 h-{W} z" fill="{BLUE}"/>')
    s.append(logo_img(ox+14, oy+12, 34))
    s.append(T(ox+56, oy+36, "ANAマイルナビ", 20, "#fff", "bold"))
    # タブ
    s.append(f'<rect x="{ox+56}" y="{oy+48}" width="74" height="24" rx="12" fill="#fff"/>')
    s.append(T(ox+93, oy+65, "検索", 14, BLUE, "bold", "middle"))
    s.append(T(ox+160, oy+65, "結果", 14, "#cfe0f2", "normal", "middle"))
    x = ox+18; w = W-36; y = oy+92
    # 出発空港
    s.append(T(x, y+12, "出発空港", 13, MUTED))
    s.append(box(x, y+20, w, 36)); s.append(T(x+12, y+43, "東京(羽田)  HND", 15))
    s.append(caret(x+w-22, y+34))
    y += 70
    # 目的地
    s.append(T(x, y+12, "目的地（複数追加できます）", 13, MUTED))
    s.append(box(x, y+20, w-92, 36)); s.append(T(x+12, y+43, "グアム  GUM", 15)); s.append(caret(x+w-92-22, y+34))
    s.append(box(x+w-84, y+20, 84, 36, 6, ORANGE, ORANGE)); s.append(T(x+w-42, y+43, "＋追加", 14, "#fff", "bold", "middle"))
    y += 66
    # チップ
    for i,(nm) in enumerate(["ホノルル HNL","グアム GUM"]):
        cw = 132
        cx = x + i*(cw+8)
        s.append(f'<rect x="{cx}" y="{y}" width="{cw}" height="28" rx="14" fill="#eef3fb" stroke="{BORDER}"/>')
        s.append(T(cx+12, y+19, nm, 13, BLUE))
        s.append(T(cx+cw-16, y+19, "×", 14, MUTED))
    y += 44
    # 期間
    half = (w-12)//2
    s.append(T(x, y+12, "期間開始", 13, MUTED)); s.append(T(x+half+12, y+12, "期間終了", 13, MUTED))
    s.append(box(x, y+20, half, 36)); s.append(T(x+12, y+43, "2026-09-01", 14))
    s.append(box(x+half+12, y+20, half, 36)); s.append(T(x+half+24, y+43, "2026-09-30", 14))
    y += 70
    # 曜日
    s.append(T(x, y+12, "出発曜日（未選択で全曜日）", 13, MUTED))
    days = ["日","月","火","水","木","金","土"]; chk=[True,False,False,False,False,True,True]
    for i,d in enumerate(days):
        dx = x + i*((w)//7)
        s.append(check(dx, y+22, chk[i])); s.append(T(dx+20, y+35, d, 13))
    y += 64
    # 復路便
    s.append(T(x, y+12, "復路便（出発便から何日後）", 13, MUTED))
    s.append(box(x, y+20, 90, 36)); s.append(T(x+16, y+43, "3", 15))
    y += 66
    # 座席クラス
    s.append(T(x, y+12, "座席クラス（複数選択可）", 13, MUTED))
    cab = [("エコノミー",True),("プレエコ",False),("ビジネス",True),("ファースト",False)]
    for i,(nm,c) in enumerate(cab):
        cx = x + (i%2)*(w//2); cy = y+22 + (i//2)*30
        s.append(check(cx, cy, c)); s.append(T(cx+22, cy+13, nm, 13))
    y += 92
    # 検索開始
    s.append(f'<rect x="{x}" y="{y}" width="{w}" height="44" rx="8" fill="{ORANGE}"/>')
    s.append(T(x+w/2, y+29, "検索開始", 18, "#fff", "bold", "middle"))
    y += 58
    s.append(T(x, y+12, "目的地 2 / クラス 2 / 検索 120 件 / 推定 約20分", 12, MUTED))
    s.append('</g>')
    return "".join(s)

def feature_list(x, y, items, gap=46, size=19):
    s=[]
    for i,it in enumerate(items):
        yy = y + i*gap
        s.append(f'<circle cx="{x+10}" cy="{yy-6}" r="10" fill="{ORANGE}"/>')
        s.append(f'<path d="M{x+5} {yy-6} l3.5 3.5 l6.5 -8" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>')
        s.append(T(x+30, yy, it, size, TEXT))
    return "".join(s)

# ===========================================================================
# 2. スクリーンショット1 (検索) 1280x800
# ===========================================================================
ss1 = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#eaf3fb"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs>
<rect width="1280" height="800" fill="url(#bg)"/>
{logo_img(70,70,56)}
{T(140,98,"ANAマイルナビ",30,BLUE,"bold")}
{T(70,180,"ANA特典航空券の空席を、",40,TEXT,"bold")}
{T(70,232,"まとめて自動検索。",40,BLUE,"bold")}
{feature_list(74,310,[
  "期間・曜日・復路の日数・座席クラスで一括検索",
  "ANA便／スターアライアンス提携便を区別して表示",
  "必要マイル・燃油サーチャージを一覧で比較",
  "並べ替え・フィルタ・CSV出力に対応",
])}
{T(70,560,"※ ANA非公式の補助ツールです。ご自身のログイン済み",13,MUTED)}
{T(70,580,"  セッションで動作し、認証情報やデータを外部送信しません。",13,MUTED)}
{panel_search(800, 88)}
</svg>'''
render(ss1, 1280, 800, "store-assets/screenshot-1-search.png")

# ===========================================================================
# サイドパネル(結果タブ)のモック
# ===========================================================================
def panel_results(ox, oy, W=600, H=624):
    s=[f'<rect x="{ox}" y="{oy}" width="{W}" height="{H}" rx="14" fill="#fff" stroke="{BORDER}" stroke-width="1.5"/>']
    s.append(f'<path d="M{ox} {oy+14} a14 14 0 0 1 14 -14 h{W-28} a14 14 0 0 1 14 14 v62 h-{W} z" fill="{BLUE}"/>')
    s.append(logo_img(ox+14, oy+12, 34))
    s.append(T(ox+56, oy+36, "ANAマイルナビ", 20, "#fff", "bold"))
    s.append(T(ox+93, oy+65, "検索", 14, "#cfe0f2", "normal", "middle"))
    s.append(f'<rect x="{ox+140}" y="{oy+48}" width="74" height="24" rx="12" fill="#fff"/>')
    s.append(T(ox+177, oy+65, "結果", 14, BLUE, "bold", "middle"))
    x=ox+16; y=oy+92; w=W-32
    # フィルタ行
    for i,(lb,vv,bw) in enumerate([("運航","すべて",118),("キャビン","すべて",128)]):
        pass
    s.append(box(x, y, 120, 32)); s.append(T(x+10, y+21, "運航: すべて", 12)); s.append(caret(x+100, y+12))
    s.append(box(x+128, y, 130, 32)); s.append(T(x+138, y+21, "クラス: すべて", 12)); s.append(caret(x+128+108, y+12))
    s.append(f'<rect x="{x+w-150}" y="{y}" width="70" height="32" rx="6" fill="{BLUE}"/>'); s.append(T(x+w-115, y+21, "CSV", 13, "#fff", "bold", "middle"))
    s.append(f'<rect x="{x+w-74}" y="{y}" width="74" height="32" rx="6" fill="#fff" stroke="{BORDER}"/>'); s.append(T(x+w-37, y+21, "クリア", 12, MUTED, "normal", "middle"))
    y += 46
    # テーブルヘッダ
    cols = [("区間",92),("往路",150),("復路",150),("クラス",70),("マイル",78),("税金・燃油",84)]
    th = 34
    s.append(f'<rect x="{x}" y="{y}" width="{w}" height="{th}" fill="#eef3f9" stroke="{BORDER}"/>')
    cx = x
    for nm,cw in cols:
        s.append(T(cx+8, y+22, nm, 12, BLUED, "bold")); cx += cw
    y += th
    rows = [
        ("KIX→HNL","09/12  NH182","ANA 21:25–10:15","09/19  NH183","ANA 11:45–16:20","ビジネス","80,000","¥45,650","ana"),
        ("KIX→HNL","09/12  UA882","UA 11:05–23:40","09/20  UA881","UA 12:30–16:55","エコノミー","40,000","¥45,650","partner"),
        ("HND→GUM","09/13  NH941","ANA 08:55–14:05","09/16  NH942","ANA 15:10–17:35","エコノミー","17,000","¥6,500","ana"),
        ("HND→SIN","09/12  NH843","ANA 11:10–17:30","09/19  NH842","ANA 22:05–06:20","ビジネス","75,000","¥38,200","ana"),
        ("KIX→FRA","09/12  LH741","LH 13:40–18:05","09/22  LH740","LH 13:25–08:05","ビジネス","90,000","¥61,300","partner"),
        ("HND→LAX","09/13  NH106","ANA 16:55–10:25","09/20  NH105","ANA 13:05–17:05","プレエコ","60,000","¥45,650","ana"),
    ]
    rh=46
    for ri,r in enumerate(rows):
        ry = y + ri*rh
        if ri%2: s.append(f'<rect x="{x}" y="{ry}" width="{w}" height="{rh}" fill="#fafcfe"/>')
        s.append(f'<line x1="{x}" y1="{ry+rh}" x2="{x+w}" y2="{ry+rh}" stroke="{BORDER}"/>')
        cx=x
        # 区間
        s.append(T(cx+8, ry+28, r[0], 13, TEXT, "bold")); cx+=cols[0][1]
        # 往路
        badge = "ANA" if r[8]=="ana" else "提携"; bc = BLUE if r[8]=="ana" else PURPLE
        s.append(T(cx+8, ry+18, r[1], 11.5, TEXT))
        s.append(f'<rect x="{cx+8}" y="{ry+26}" width="32" height="15" rx="7" fill="{bc}"/>'); s.append(T(cx+24, ry+37, badge, 9.5, "#fff", "bold", "middle"))
        s.append(T(cx+44, ry+38, r[2], 10.5, MUTED)); cx+=cols[1][1]
        # 復路
        s.append(T(cx+8, ry+18, r[3], 11.5, TEXT))
        s.append(f'<rect x="{cx+8}" y="{ry+26}" width="32" height="15" rx="7" fill="{bc}"/>'); s.append(T(cx+24, ry+37, badge, 9.5, "#fff", "bold", "middle"))
        s.append(T(cx+44, ry+38, r[4], 10.5, MUTED)); cx+=cols[2][1]
        # クラス
        s.append(T(cx+8, ry+28, r[5], 11.5)); cx+=cols[3][1]
        # マイル
        s.append(T(cx+cols[4][1]-8, ry+28, r[6], 13, TEXT, "bold", "end")); cx+=cols[4][1]
        # 税金燃油
        s.append(T(cx+cols[5][1]-8, ry+28, r[7], 12, TEXT, "normal", "end"))
    return "".join(s)

# ===========================================================================
# 3. スクリーンショット2 (結果) 1280x800
# ===========================================================================
ss2 = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800">
<defs><linearGradient id="bg2" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#eaf3fb"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs>
<rect width="1280" height="800" fill="url(#bg2)"/>
{logo_img(70,66,52)}
{T(134,92,"ANAマイルナビ",28,BLUE,"bold")}
{T(70,150,"空席・必要マイル・燃油を",34,TEXT,"bold")}
{T(70,196,"一覧で比較。",34,BLUE,"bold")}
{feature_list(74,270,[
  "出発地→目的地・往復の便と時刻を一目で確認",
  "ANA／提携便をバッジで区別",
  "必要マイル・税金・燃油サーチャージを横並び比較",
  "マイルや料金で並べ替え、CSVで保存",
], gap=44, size=17)}
{panel_results(636, 88)}
</svg>'''
render(ss2, 1280, 800, "store-assets/screenshot-2-results.png")

# ===========================================================================
# 4. プロモタイル(小) 440x280
# ===========================================================================
promo = f'''<svg xmlns="http://www.w3.org/2000/svg" width="440" height="280">
<defs><linearGradient id="pg" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#0a63b0"/><stop offset="1" stop-color="#003a73"/></linearGradient></defs>
<rect width="440" height="280" fill="url(#pg)"/>
<circle cx="360" cy="60" r="150" fill="#ffffff" opacity="0.05"/>
{logo_img(150,28,140)}
{T(220,196,"ANAマイルナビ",30,"#fff","bold","middle")}
{T(220,228,"特典航空券の空席をまとめて検索",15,"#cfe0f2","normal","middle")}
{T(220,252,"必要マイル・燃油・空席を一覧比較",15,"#cfe0f2","normal","middle")}
</svg>'''
render(promo, 440, 280, "store-assets/promo-small-440x280.png")

# ===========================================================================
# 5. マーキー 1400x560
# ===========================================================================
marquee = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="560">
<defs><linearGradient id="mg" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#0a63b0"/><stop offset="1" stop-color="#003a73"/></linearGradient></defs>
<rect width="1400" height="560" fill="url(#mg)"/>
<circle cx="1180" cy="120" r="320" fill="#ffffff" opacity="0.05"/>
<circle cx="1240" cy="460" r="180" fill="#ffffff" opacity="0.04"/>
{logo_img(120,150,260)}
{T(440,250,"ANAマイルナビ",70,"#fff","bold")}
{T(444,320,"ANA特典航空券の空席を、まとめて自動検索。",30,"#dbe9f7")}
{feature_list(446,386,[
  "期間・曜日・復路の日数・座席クラスで一括検索",
  "ANA／提携便・必要マイル・燃油サーチャージを一覧比較・CSV出力",
], gap=46, size=22)}
</svg>'''
# feature_list uses dark text; on dark bg make custom
marquee = marquee.replace(f'fill="{TEXT}"', 'fill="#ffffff"')
render(marquee, 1400, 560, "store-assets/marquee-1400x560.png")

print("DONE")
