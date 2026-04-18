FROM python:3.12-slim

WORKDIR /evals

COPY requirements.txt /evals/requirements.txt
RUN pip install --no-cache-dir -r /evals/requirements.txt

COPY . /evals

ENTRYPOINT ["python", "/evals/runner.py"]
