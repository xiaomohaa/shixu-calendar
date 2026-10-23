from pathlib import Path
from PIL import Image, ImageDraw

folder = Path(__file__).resolve().parent.parent / 'build'
folder.mkdir(exist_ok=True)
image = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
d = ImageDraw.Draw(image)
d.rounded_rectangle((8, 8, 248, 248), radius=52, fill='#cf5447')
d.rounded_rectangle((53, 65, 203, 204), radius=18, fill='#fcfaf7')
d.rounded_rectangle((53, 65, 203, 102), radius=12, fill='#ead8cd')
d.rectangle((53, 85, 203, 103), fill='#ead8cd')
for x in (87, 169):
    d.rounded_rectangle((x-5, 48, x+5, 82), radius=5, fill='#fcfaf7')
for x,y in ((87,130),(128,130),(169,130),(87,169),(128,169),(169,169)):
    d.rounded_rectangle((x-9,y-7,x+9,y+7),radius=3,fill='#cf5447' if x==128 and y==169 else '#8f8983')
image.save(folder / 'icon.png')
image.save(folder / 'icon.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
