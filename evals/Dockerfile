FROM python:3.12-alpine@sha256:6d43704baacd1bfbe7c295d7f13079d5d8104ed33568873133f8fc69980419df

WORKDIR /evals

COPY requirements.txt /evals/requirements.txt
RUN pip install --no-cache-dir -r /evals/requirements.txt

COPY . /evals

ENTRYPOINT ["python", "/evals/runner.py"]
