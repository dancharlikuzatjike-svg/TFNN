#!/bin/bash
# Builds TFNN-4-problems-vo.mp4: espeak-ng narration fitted to each slide (build/list.txt durations)
set -e
cd "$(dirname "$0")/build"
L=(
"Every farmer has these four problems. Most don't even know they're losing money because of them."
"Problem one. You sell an ox, but you don't really know what it's worth. So you take the buyer's price."
"With T F N N, you see what every animal and your whole herd is worth, updated every week from Namibian market prices. Now you know your price before you sell."
"Problem two. Your records are in your head or a notebook. Animals go missing, and treatments get forgotten."
"T F N N keeps a record of every animal: its tag, births, treatments, sales and deaths. And it reminds you before a treatment is due."
"Problem three. Too few calves this year. The bull wasn't checked, and the breeding season came and went."
"T F N N's season calendar and bull care tell you what to do and when, so your bulls are ready and your calving rate stays up."
"Problem four. Money comes in, money goes out, but is the farm actually making a profit? Most farmers can't say."
"T F N N puts your sales and expenses side by side for each species, so you can see what's making money and what isn't."
"Know your price. Track every animal. Get more calves. See your profit."
"In English, Afrikaans and German, and made for farms with weak signal."
"T F N N. The Future of Namibian Farming. Sign up today."
)
for i in "${!L[@]}"; do espeak-ng -v en-us -s 135 -p 40 -w v$i.wav "${L[$i]}"; done
# slide length = speech + 0.4s lead-in + 1s pause
D=(); : > list.txt
for i in "${!L[@]}"; do
  len=$(ffprobe -v error -show_entries format=duration -of csv=p=0 v$i.wav)
  d=$(python3 -c "print(round($len+1.4,2))"); D+=($d)
  printf "file 's$i.png'\nduration $d\n" >> list.txt
done
echo "file 's$((${#L[@]}-1)).png'" >> list.txt
ffmpeg -y -loglevel error -f concat -safe 0 -i list.txt -vf "fps=30,format=yuv420p,fade=t=in:st=0:d=0.5" -c:v libx264 -crf 20 ../TFNN-4-problems.mp4
: > a.txt
for i in "${!L[@]}"; do
  ffmpeg -y -loglevel error -i v$i.wav -af "adelay=400|400,apad,atrim=0:${D[$i]},aresample=44100" -ac 1 n$i.wav
  echo "file 'n$i.wav'" >> a.txt
done
ffmpeg -y -loglevel error -f concat -safe 0 -i a.txt -c:a aac -b:a 160k voice.m4a
ffmpeg -y -loglevel error -i ../TFNN-4-problems.mp4 -i voice.m4a -c:v copy -c:a copy -shortest ../TFNN-4-problems-vo.mp4
ffprobe -v error -show_entries format=duration -of csv=p=0 ../TFNN-4-problems-vo.mp4
