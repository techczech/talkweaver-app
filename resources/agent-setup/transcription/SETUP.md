# Set up transcription for TalkWeaver

For an agent setting up transcription on the person's computer. Transcription is optional:
nothing else in TalkWeaver needs it. Everything you need ships in this folder; do not look for
anything else on the computer.

## What ships here

- `parakeet_to_srt.py`: the transcription script. TalkWeaver runs it as
  `<python> parakeet_to_srt.py <audio.wav> -o <out.srt>`.
- `requirements.txt`: the Python packages the script needs.
- `ffmpeg` is not needed from you: TalkWeaver ships its own and uses it when no ffmpeg path is set.

## Which computers

The shipped engine (Parakeet on MLX) runs on a Mac with Apple silicon. On Windows or an Intel Mac,
`requirements.txt` installs nothing and the script cannot transcribe; tell the person so. An engine
of their own works if it takes the same arguments (`<audio.wav> -o <out.srt>`) and writes an SRT file.

## Paths

The prompt you were given names two folders on this computer:

- the set-up folder: this folder, inside the installed app;
- TalkWeaver's user-data folder. Create the environment in `<user-data>/transcription/`.

## Steps

1. Find Python 3.10 or newer: `python3 --version` (macOS) or `py -3 --version` (Windows). If there is
   none, ask the person before installing one (the python.org installer is the plain route).
2. Create the environment in the user-data folder:
   - macOS: `python3 -m venv "<user-data>/transcription/venv"`
   - Windows: `py -3 -m venv "<user-data>\transcription\venv"`
3. Install the packages from this folder:
   - macOS: `"<user-data>/transcription/venv/bin/python" -m pip install -r "<set-up folder>/requirements.txt"`
   - Windows: `"<user-data>\transcription\venv\Scripts\python.exe" -m pip install -r "<set-up folder>\requirements.txt"`
4. Check the script answers: `<venv python> "<set-up folder>/parakeet_to_srt.py" --help`.
5. Fetch the speech model once (about 2.5 GB, into the standard Hugging Face cache in the person's
   home folder, where the script looks for it):
   `<venv python> -c "from huggingface_hub import snapshot_download; snapshot_download('mlx-community/parakeet-tdt-0.6b-v3')"`
   Skip this step on a computer where the shipped engine cannot run.
6. Give TalkWeaver the two paths: the venv's Python and `parakeet_to_srt.py` in the set-up folder.
   Either ask the person to paste them into Settings → Transcription and press Save, or run
   `TalkWeaver setup transcription --python <venv python> --script <set-up folder>/parakeet_to_srt.py`
   where that command is available (both as full paths: the command refuses a relative path or `~`).
   Leave ffmpeg unset unless the person wants their own.
7. Settings → Transcription should now read "Ready". If it names a missing thing, fix that one.

## Do not

- Install packages outside the venv, or change the person's shell profile.
- Copy the script elsewhere: the path inside the app stays correct when TalkWeaver updates.
- Ask for, read or print any token or password; transcription needs none.
